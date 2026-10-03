// scripts/bridge/claude-adapter.mjs — Claude sessions as one bridge host (docs/bridge.md).
//
// Claude has no shared daemon, so two things dial in here over 127.0.0.1 (newline
// JSON-RPC, random port, token in ~/.claude/bridge/runtime.json):
//   - each session's session-bridge channel (claude_plugins/session-bridge) stays connected:
//       register {token, sessionId, cwd}, reply {text}, permission_request {...}
//       <- inbound {text, user}, permission {request_id, behavior}
//   - bridge-hook.js makes one-shot calls: mirror {token, sessionIds, kind, text|state}
//     (kind prompt | final | activity | end), and question {token, sessionIds, questions, wait},
//     held open for a Telegram-started turn until the answer arrives
// and it emits the host-neutral events every adapter emits (see daemon.mjs):
//   up {id, cwd, backlog}, prompt {id, text}, final {id, text},
//   approval {id, ref, summary, answerable}, question {id, ref, questions, answerable},
//   question-resolved {id, ref}, down {id}.
// Session state is a state machine driven only by hook edges: prompt / activity -> running,
// final -> idle, Notification -> waiting-approval | waiting-input | idle, SessionEnd -> down.
// A hook call names the session's current id and the id its process started with (the
// channel registered under the latter; /clear mints a new current one), and is held briefly
// when it beats the channel's registration. CLAUDE_PID is not usable: a nested `claude`
// inherits its parent's.

import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';

const AUTH_TIMEOUT_MS = 5000;
const STATES = new Set(['running', 'idle', 'waiting-approval', 'waiting-input']);
const HOLD_MS = 30000;

/** A prompt that arrived through a channel, as UserPromptSubmit reports it -> its text. */
export function unwrapChannel(text) {
  const m = /^\s*<channel\b[^>]*>([\s\S]*)<\/channel>\s*$/.exec(text);
  return m ? m[1].trim() : text;
}

const ENVELOPE_TAGS = 'agent-message|task-notification|system-reminder';
const ENVELOPES = new RegExp(`^\\s*(?:<(${ENVELOPE_TAGS})\\b[^>]*>[\\s\\S]*?</\\1>\\s*)+$`);
const STOP_HOOK_FEEDBACK = /^\s*Stop hook feedback:/i;

/** A prompt the harness or a plugin injected (wholly envelopes), not one a person wrote. */
export function isEnvelope(text) {
  return ENVELOPES.test(text) || STOP_HOOK_FEEDBACK.test(text);
}

export class ClaudeAdapter extends EventEmitter {
  constructor({ token = crypto.randomBytes(24).toString('hex'), now = Date.now } = {}) {
    super();
    this.agent = 'claude';
    this.token = token;
    this.now = now;
    // sessionId -> { peer, socket, replies, approvals, questions, claudePid, humanTurn, remoteTurn, activity }
    this.sessions = new Map();
    this.held = [];              // hook calls that arrived before their session registered
  }

  listen(port = 0) {
    this.server = net.createServer((s) => this.#onSocket(s));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  close() {
    for (const s of this.sessions.values()) s.socket.destroy();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  #tokenOk(t) {
    return typeof t === 'string' && t.length === this.token.length &&
      crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
  }

  #onSocket(socket) {
    let sessionId = null;
    const authTimer = setTimeout(() => { if (!sessionId) socket.destroy(); }, AUTH_TIMEOUT_MS);
    authTimer.unref();
    const unauthorized = () => { setImmediate(() => socket.destroy()); return Object.assign(new Error('unauthorized'), { code: 401 }); };
    const ids = (p) => ({ sessionIds: (Array.isArray(p.sessionIds) ? p.sessionIds : []).map(String), claudePid: Number(p.claudePid) || null });
    const peer = new JsonRpcPeer((t) => socket.write(t + '\n'), {
      onRequest: (method, p = {}) => {
        if (method === 'register') {
          if (!this.#tokenOk(p.token) || !p.sessionId) throw unauthorized();
          clearTimeout(authTimer);
          sessionId = String(p.sessionId);
          const previous = this.sessions.get(sessionId);
          if (previous) {
            this.#withdraw(sessionId, previous);
            previous.socket.destroy();
          }
          // A turn may be in flight when the bridge restarts: with no prompt seen by this
          // daemon, assume a human turn, so its answer is mirrored rather than lost.
          this.sessions.set(sessionId, { peer, socket, replies: [], approvals: new Set(), questions: new Map(),
            claudePid: Number(p.claudePid) || null, humanTurn: previous ? previous.humanTurn : true,
            remoteTurn: previous?.remoteTurn ?? false, activity: previous?.activity });
          this.emit('up', { id: sessionId, cwd: p.cwd, backlog: [] });
          this.#emitStatus(sessionId);
          this.#release();
          return { ok: true };
        }
        if (method === 'mirror') {
          if (!this.#tokenOk(p.token)) throw unauthorized();
          const bad = () => Object.assign(new Error('bad kind'), { code: -32602 });
          if (!['prompt', 'final', 'activity', 'end'].includes(p.kind)) throw bad();
          if (p.kind === 'activity' && !STATES.has(p.state)) throw bad();
          const routed = this.#mirror({ ...ids(p), retry: p.retry === true, kind: p.kind,
            ...(p.status === 'failed' ? { status: 'failed' } : {}), ...(p.kind === 'activity' ? { state: p.state } : {}), text: String(p.text ?? '') });
          return { ok: true, routed };
        }
        if (method === 'question') {
          if (!this.#tokenOk(p.token)) throw unauthorized();
          clearTimeout(authTimer);   // a waiting question outlives the auth window
          return this.#question(socket, ids(p), p);
        }
        if (method === 'codex_attachment') {
          if (!this.#tokenOk(p.token)) throw unauthorized();
          if (typeof p.sessionId !== 'string' || !this.sendCodexAttachment) throw new Error('Codex attachment session required');
          return this.sendCodexAttachment(p.sessionId, p);
        }
        if (!sessionId || this.sessions.get(sessionId)?.socket !== socket) throw unauthorized();
        if (method === 'attachment') {
          if (!this.sendAttachment) throw new Error('attachment delivery unavailable');
          return this.sendAttachment(sessionId, p);
        }
        if (method === 'reply') {
          const text = String(p.text ?? '');
          this.sessions.get(sessionId)?.replies.push(text.trim());
          this.emit('final', { id: sessionId, text });
          return { ok: true };
        }
        if (method === 'permission_request') {
          const pending = this.sessions.get(sessionId).approvals;
          if (typeof p.request_id !== 'string' || !p.request_id.trim() ||
              typeof p.tool_name !== 'string' || !p.tool_name.trim() || pending.has(p.request_id)) {
            throw Object.assign(new Error('invalid or duplicate permission request'), { code: -32602 });
          }
          pending.add(p.request_id);
          this.emit('approval', {
            id: sessionId, ref: p.request_id, answerable: true,
            summary: `${p.tool_name}: ${p.description ?? ''}${p.input_preview ? `\n${String(p.input_preview).slice(0, 1500)}` : ''}`,
          });
          this.#emitStatus(sessionId);
          return { ok: true };
        }
        throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
      },
    });
    socket.setEncoding('utf8');
    socket.on('data', lineSplitter((l) => peer.receive(l)));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authTimer);
      // A hook that stopped waiting (timeout, killed): its question goes back to the terminal.
      for (const [id, s] of this.sessions) {
        for (const [ref, q] of s.questions) {
          if (q.socket !== socket) continue;
          s.questions.delete(ref);
          this.emit('question-resolved', { id, ref });
        }
      }
      if (sessionId && this.sessions.get(sessionId)?.socket === socket) this.#end(sessionId);
    });
  }

  /** The session is gone (channel closed or SessionEnd): withdraw its controls, report down. */
  #end(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.#withdraw(id, s);
    this.sessions.delete(id);
    this.#emitStatus(id);
    this.emit('down', { id });
  }

  #withdraw(id, session) {
    // This invalidates bridge controls; it does not claim Claude accepted a verdict.
    for (const ref of session.approvals) this.emit('approval-resolved', { id, ref, reason: 'correlation-withdrawn' });
    session.approvals.clear();
    for (const [ref, q] of session.questions) { q.resolve({ answers: null }); this.emit('question-resolved', { id, ref }); }
    session.questions.clear();
    this.#emitStatus(id);
  }

  #route({ sessionIds, claudePid }) {
    const byId = sessionIds.find((id) => this.sessions.has(id));
    if (byId || !claudePid) return byId ?? null;
    // After /clear no id matches; the claude process that owns the channel still does.
    for (const [id, s] of this.sessions) if (s.claudePid === claudePid) return id;
    return null;
  }

  /**
   * An AskUserQuestion the PreToolUse hook reports. In a turn started from Telegram the hook
   * waits for the Telegram answer (the terminal dialog is not shown meanwhile); in a turn
   * typed locally the question is posted as information and the hook returns at once.
   */
  #question(socket, route, p) {
    const id = this.#route(route);
    const s = id && this.sessions.get(id);
    if (!s) return { answers: null };
    const questions = (Array.isArray(p.questions) ? p.questions : []).map((q, i) => ({
      id: String(i), header: String(q?.header ?? ''), question: String(q?.question ?? ''),
      isOther: true, isSecret: false, multiSelect: q?.multiSelect === true,
      options: Array.isArray(q?.options) ? q.options.map((o) => ({ label: String(o?.label ?? ''), description: String(o?.description ?? '') })) : null,
    }));
    if (!questions.length) return { answers: null };
    const ref = crypto.randomBytes(12).toString('hex');
    s.activity = 'waiting-input';
    this.#emitStatus(id);
    if (!(p.wait === true && s.remoteTurn)) {
      this.emit('question', { id, ref, questions, answerable: false });
      return { answers: null };
    }
    return new Promise((resolve) => {
      s.questions.set(ref, { socket, questions, resolve });
      this.emit('question', { id, ref, questions, answerable: true });
    });
  }

  #mirror(m) {
    const id = this.#route(m);
    if (!id) {
      // Only prompts and finals are held for a channel that has not registered yet (a retry's
      // first copy already is); a later hook carries fresher state than a held activity.
      if (m.kind !== 'prompt' && m.kind !== 'final') return false;
      const now = this.now();
      this.held = [...this.held.filter((h) => now - h.at < HOLD_MS), ...(m.retry ? [] : [{ m, at: now }])];
      return false;
    }
    // A retry routed by process: its unroutable first copy must not be released later.
    if (m.retry) this.held = this.held.filter((h) => !(h.m.kind === m.kind && h.m.text === m.text));
    if (m.kind === 'end') { this.#end(id); return true; }
    const s = this.sessions.get(id);
    s.activity = m.kind === 'activity' ? m.state : m.kind === 'prompt' ? 'running' : 'idle';
    this.#emitStatus(id);
    if (m.kind === 'activity') return true;
    // Only human-initiated turns are mirrored: a prompt typed locally or sent from Telegram.
    // Envelope prompts, and Stop-hook continuations (a final with no prompt since the last
    // one), are the harness talking to itself.
    if (m.kind === 'prompt') {
      s.humanTurn = !isEnvelope(m.text);
      if (s.humanTurn) {
        // A channel prompt is wrapped: that turn came from Telegram, any other was typed here.
        const text = unwrapChannel(m.text);
        s.remoteTurn = text !== m.text;
        this.emit('prompt', { id, text });
      }
      return true;
    }
    const human = s.humanTurn;
    s.humanTurn = false;
    // The model may already have sent this answer with the reply tool.
    const dup = s.replies.includes(m.text.trim());
    s.replies = [];
    if (human && m.text.trim() && !dup) this.emit('final', { id, text: m.text, ...(m.status ? { status: m.status } : {}) });
    return true;
  }

  #release() {
    const held = this.held;
    this.held = [];
    for (const { m, at } of held) {
      if (this.#route(m)) this.#mirror(m); else this.held.push({ m, at });
    }
  }

  // ── host interface used by the daemon ──

  async inject(id, text, user) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('channel disconnected');
    s.peer.notify('inbound', { text, user: user ?? '' });
    s.humanTurn = true;   // whether or not UserPromptSubmit reports channel prompts
    s.remoteTurn = true;
    s.activity = 'running';
    this.#emitStatus(id);
  }

  status(id) { return this.sessions.has(id) ? 'channel connected' : 'channel disconnected'; }

  /** The state the hooks last reported; a channel approval cannot prove how it was resolved locally. */
  statusSnapshot(id) {
    const s = this.sessions.get(id);
    return s ? { state: s.activity ?? 'unknown' } : { state: 'disconnected' };
  }

  #emitStatus(id) { this.emit('status', { id, ...this.statusSnapshot(id) }); }

  /** Answer a waiting question: `answers` maps question id -> chosen strings. */
  answerQuestion(ref, answers, id) {
    const s = this.sessions.get(id);
    const q = s?.questions.get(ref);
    if (!q || !answers || q.questions.some((x) => !answers[x.id]?.length)) return false;
    s.questions.delete(ref);
    q.resolve({ answers: Object.fromEntries(q.questions.map((x) => [x.question, [].concat(answers[x.id]).map(String).join(', ')])) });
    s.activity = 'running';
    this.#emitStatus(id);
    return true;
  }

  /** The question could not be offered on Telegram: let the terminal dialog show it. */
  releaseQuestion(ref, id) {
    const s = this.sessions.get(id);
    const q = s?.questions.get(ref);
    if (!q) return false;
    s.questions.delete(ref);
    q.resolve({ answers: null });
    return true;
  }

  answerApproval(ref, allow, id) {
    const s = this.sessions.get(id);
    if (!s || s.socket.destroyed || !s.approvals.delete(ref)) return false;
    s.peer.notify('permission', { request_id: ref, behavior: allow ? 'allow' : 'deny' });
    this.#emitStatus(id);
    return true;
  }
}
