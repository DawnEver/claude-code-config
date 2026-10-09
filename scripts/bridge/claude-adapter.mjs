// scripts/bridge/claude-adapter.mjs — Claude sessions as one bridge host (docs/bridge.md).
//
// Claude has no shared daemon, so two things dial in here over 127.0.0.1 (newline
// JSON-RPC, random port, token in ~/.claude/bridge/runtime.json):
//   - each session's session-bridge channel (claude_plugins/session-bridge) stays connected:
//       register {token, sessionId, cwd}, reply {text}, permission_request {...}
//       <- inbound {text, user}, permission {request_id, behavior}
//   - bridge-hook.js makes one-shot calls: mirror {token, sessionId, kind, text|state}
//     (kind prompt | final | answer | activity; a final may answer {deliver: [{text, user}]}), and question {token, sessionId, questions, wait},
//     held open for a Telegram-started turn until the answer arrives
// and it emits the host-neutral events every adapter emits (see daemon.mjs):
//   up {id, cwd, backlog}, prompt {id, text}, final {id, text},
//   approval {id, ref, summary, answerable}, question {id, ref, questions, answerable},
//   question-resolved {id, ref}, down {id}.
// One channel = one claude process, keyed by the conversation id it started with. Its socket
// is the only liveness signal: it closes exactly when the process exits (SessionEnd also fires
// on in-process /clear and /resume, so it proves nothing). Session state is driven by hook
// edges: prompt / activity -> running, final -> idle, Notification -> waiting-approval |
// waiting-input | idle.
// A hook names the conversation id current in its process. /clear and /resume change it; the
// hook's retry then names its claude process, and the session learns the new id, so later
// calls (activity, questions) route by id again. A hook call is held briefly when it beats the
// channel's registration. CLAUDE_PID is not usable: a nested `claude` inherits its parent's.
// A session Claude Code gives no channel (no flag, or a third-party provider such as ccds)
// cannot receive inbound: its Telegram messages are queued and handed to the Stop hook at the
// end of its next turn, which continues the session with them.

import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';
import { isValidAlias } from '../shared/seats.mjs';

const AUTH_TIMEOUT_MS = 5000;
const heldKey = (m) => JSON.stringify([m.kind, m.text, m.texts ?? null]);
const STATES = new Set(['running', 'idle', 'waiting-approval', 'waiting-input']);
const HOLD_MS = 30000;

const CONTINUED_TAIL_BYTES = 64 * 1024;   // the record is appended when the conversation moves on

/** The session a transcript says its conversation continued in, or null (read from its tail). */
export function continuedIn(file) {
  let tail = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, CONTINUED_TAIL_BYTES));
      tail = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, size - buf.length));
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  let next = null;
  for (const l of tail.split('\n')) {
    if (!l.includes('"continued-in"')) continue;
    try {
      const e = JSON.parse(l);
      if (e?.type === 'continued-in' && typeof e.continuedInSessionId === 'string' && e.continuedInSessionId) next = e.continuedInSessionId;
    } catch { /* cut line */ }
  }
  return next;
}

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
    // sessionId -> { peer, socket, ids, sent, approvals, questions, claudePid, remoteTurn, localQuestion, activity, transcript }
    // ids: every conversation id seen in this process; each id belongs to at most one session.
    // transcript: its JSONL path (from the channel, then the hooks), read for `continued-in`.
    this.sessions = new Map();
    this.held = [];              // hook calls that arrived before their session registered
    this.sockets = new Set();
  }

  listen(port = 0) {
    this.server = net.createServer((s) => this.#onSocket(s));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  close() {
    // Every socket, not only sessions': a stale channel stays connected without being one.
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  #tokenOk(t) {
    return typeof t === 'string' && t.length === this.token.length &&
      crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
  }

  #onSocket(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    let sessionId = null;
    const authTimer = setTimeout(() => { if (!sessionId) socket.destroy(); }, AUTH_TIMEOUT_MS);
    authTimer.unref();
    const unauthorized = () => { setImmediate(() => socket.destroy()); return Object.assign(new Error('unauthorized'), { code: 401 }); };
    const ids = (p) => ({ sessionId: typeof p.sessionId === 'string' ? p.sessionId : '', claudePid: Number(p.claudePid) || null,
      ...(typeof p.transcriptPath === 'string' && p.transcriptPath ? { transcriptPath: p.transcriptPath } : {}) });
    const peer = new JsonRpcPeer((t) => socket.write(t + '\n'), {
      onRequest: (method, p = {}) => {
        if (method === 'register') {
          if (!this.#tokenOk(p.token) || !p.sessionId) throw unauthorized();
          clearTimeout(authTimer);
          sessionId = String(p.sessionId);
          const transcript = typeof p.transcriptPath === 'string' && p.transcriptPath ? p.transcriptPath : null;
          // A channel of a conversation already continued in a live session is stale: never a session.
          const next = transcript && continuedIn(transcript);
          if (next && next !== sessionId && this.sessions.has(next)) return { ok: true, continuedIn: next };
          const previous = this.sessions.get(sessionId);
          if (previous) {
            this.#withdraw(sessionId, previous);
            previous.socket.destroy();
          }
          // A turn may be in flight when the bridge restarts: with no prompt seen by this
          // daemon, assume a human turn, so its answer is mirrored rather than lost.
          this.#claim(sessionId, null);
          this.sessions.set(sessionId, { peer, socket, ids: new Set([...(previous?.ids ?? []), sessionId]), sent: previous?.sent ?? new Set(), approvals: new Set(), questions: new Map(),
            claudePid: Number(p.claudePid) || null, inbound: p.inbound !== false, thirdParty: p.thirdParty === true,
            queued: previous?.queued ?? [], localQuestion: previous?.localQuestion ?? false,
            remoteTurn: previous?.remoteTurn ?? false, activity: previous?.activity, transcript: transcript ?? previous?.transcript ?? null });
          this.emit('up', { id: sessionId, cwd: p.cwd, seat: isValidAlias(p.seat) ? p.seat : null, backlog: [] });
          this.#emitStatus(sessionId);
          this.#takeOver(sessionId);
          this.#release();
          return { ok: true };
        }
        if (method === 'mirror') {
          if (!this.#tokenOk(p.token)) throw unauthorized();
          const bad = () => Object.assign(new Error('bad kind'), { code: -32602 });
          if (!['prompt', 'final', 'answer', 'activity'].includes(p.kind)) throw bad();
          if (p.kind === 'activity' && !STATES.has(p.state)) throw bad();
          const r = this.#mirror({ ...ids(p), retry: p.retry === true, ...(p.replay === true ? { replay: true } : {}), kind: p.kind,
            ...(p.status === 'failed' ? { status: 'failed' } : {}), ...(p.kind === 'activity' ? { state: p.state } : {}), text: String(p.text ?? ''),
            ...(Array.isArray(p.texts) ? { texts: p.texts.map(String) } : {}) });
          return { ok: true, routed: r !== false, ...(Array.isArray(r) ? { deliver: r } : {}) };
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
          this.sessions.get(sessionId)?.sent.add(text.trim());
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

  /** The claude process is gone (its channel closed): withdraw its controls, report down. */
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

  #route({ sessionId, claudePid }) {
    for (const [id, s] of this.sessions) if (s.ids.has(sessionId)) return id;
    if (!claudePid) return null;
    // After /clear or /resume no id matches; the claude process that owns the channel does.
    for (const [id, s] of this.sessions) {
      if (s.claudePid !== claudePid) continue;
      if (sessionId) { this.#claim(sessionId, id); s.ids.add(sessionId); }
      return id;
    }
    return null;
  }

  /**
   * Agent view relaunches a conversation under a new session id and a new claude process
   * (without ccc's channel flag), while the old process and its channel stay up. Claude Code
   * records it in the OLD transcript only: `{type: 'continued-in', continuedInSessionId}`.
   * That record is the sole trigger — a fork shares history but never writes one.
   */
  #takeOver(id) {
    for (const [old, o] of [...this.sessions]) {
      if (old !== id && o.transcript && continuedIn(o.transcript) === id) this.#supersede(old, id);
    }
  }

  /** A hook names the session's transcript: the first time, look for the session it continues. */
  #learnTranscript(id, file) {
    const s = this.sessions.get(id);
    if (!s || !file || s.transcript === file) return;
    s.transcript = file;
    this.#takeOver(id);
  }

  /** Session `next` continues session `old`: the daemon moves its Topic, its queue moves along. */
  #supersede(old, next) {
    const o = this.sessions.get(old);
    const n = this.sessions.get(next);
    if (!o || !n) return;
    this.#withdraw(old, o);
    this.sessions.delete(old);
    this.emit('superseded', { id: next, from: old });
    const queued = o.queued;
    if (!queued.length) return;
    if (!n.inbound) { n.queued.push(...queued); return; }
    for (const q of queued) n.peer.notify('inbound', q);
    n.remoteTurn = true;
    n.activity = 'running';
    this.#emitStatus(next);
  }

  /** A conversation id now lives in session `owner` (null: a channel registering it): no other keeps it. */
  #claim(convId, owner) {
    for (const [id, s] of this.sessions) if (id !== owner) s.ids.delete(convId);
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
    this.#learnTranscript(id, route.transcriptPath);
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
      s.localQuestion = true;   // its answer, given in the terminal, is mirrored by PostToolUse
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
      if (m.kind !== 'prompt' && m.kind !== 'final' && m.kind !== 'answer') return false;
      const now = this.now();
      const expired = this.held.filter((h) => now - h.at >= HOLD_MS);
      for (const h of expired) this.emit('warn', `claude: dropped unroutable ${h.m.kind} for ${h.m.sessionId} (no registered channel)`);
      this.held = [...this.held.filter((h) => now - h.at < HOLD_MS), ...(m.retry ? [] : [{ m, at: now }])];
      return false;
    }
    // A retry routed by process: its unroutable first copy must not be released later.
    if (m.retry) this.held = this.held.filter((h) => heldKey(h.m) !== heldKey(m));
    this.#learnTranscript(id, m.transcriptPath);
    const s = this.sessions.get(id);
    s.activity = m.kind === 'activity' ? m.state : m.kind === 'final' ? 'idle' : 'running';
    this.#emitStatus(id);
    if (m.kind === 'activity') {
      // A Notification saying what it waits for; a channel permission request already posted it.
      if (m.text.trim() && !(m.state === 'waiting-approval' && s.approvals.size)) this.emit('notice', { id, text: m.text, alert: true });
      return true;
    }
    if (m.kind === 'answer') {
      if (s.localQuestion && m.text.trim()) this.emit('notice', { id, text: `answered locally: ${m.text}` });
      s.localQuestion = false;
      return true;
    }
    // A prompt opens a new turn. Envelope prompts (harness/plugin injections) are not shown,
    // but the answer they trigger is: every turn end mirrors the text not yet sent.
    if (m.kind === 'prompt') {
      s.sent = new Set();
      if (!isEnvelope(m.text)) {
        // A channel prompt is wrapped: that turn came from Telegram, any other was typed here.
        const text = unwrapChannel(m.text);
        s.remoteTurn = text !== m.text;
        this.emit('prompt', { id, text });
      }
      return true;
    }
    // A Stop-hook continuation ends with the same turn's blocks again: send only the new
    // ones, and none the model already sent with the reply tool.
    const blocks = (m.texts ?? [m.text]).map((t) => t.trim()).filter(Boolean);
    const fresh = blocks.filter((b) => !s.sent.has(b));
    for (const b of blocks) s.sent.add(b);
    if (fresh.length || m.status === 'failed') this.emit('final', { id, text: fresh.join('\n\n'), ...(m.status ? { status: m.status } : {}) });
    // A failed turn (StopFailure) cannot be continued by its hook; the queue waits for the next.
    // A spool replay is not this session's live Stop hook: only that one can deliver the queue.
    if (!s.queued.length || m.status === 'failed' || m.replay) return true;
    const deliver = s.queued;
    s.queued = [];
    s.sent = new Set();
    s.remoteTurn = true;
    s.activity = 'running';
    this.#emitStatus(id);
    return deliver;
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
    // Agent view moved the conversation on: deliver to the live session, or hold for it.
    const next = s.transcript && continuedIn(s.transcript);
    if (next && next !== id) {
      if (this.sessions.has(next)) { this.#supersede(id, next); return this.inject(next, text, user); }
      s.queued.push({ text, user: user ?? '' });
      return { queued: true, note: `queued: this conversation continued in session ${next} (agent view relaunched it), which has not connected yet; the message is delivered when it does.` };
    }
    if (!s.inbound) {
      s.queued.push({ text, user: user ?? '' });
      const why = s.thirdParty
        ? 'this session runs a third-party provider, which Claude Code gives no channel'
        : 'this session has no channel (not started with ccc, or relaunched by agent view / in the background, which drops ccc\'s channel flag), so Claude Code drops channel messages';
      const when = s.activity === 'running' ? 'it is delivered when the current turn ends'
        : 'the message waits for its next turn to end (type something locally to wake it)';
      const fix = s.thirdParty ? 'Use ccc or cods to message it directly.' : `Resume it from a terminal with ccc --resume ${id} to message it directly.`;
      return { queued: true, note: `queued: ${why}, so ${when}. ${fix}` };
    }
    s.peer.notify('inbound', { text, user: user ?? '' });
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
