// scripts/bridge/claude-adapter.mjs — Claude sessions as one bridge host (docs/bridge.md).
//
// Claude has no shared daemon, so two things dial in here over 127.0.0.1 (newline
// JSON-RPC, random port, token in ~/.claude/bridge/runtime.json):
//   - each session's session-bridge channel (claude_plugins/session-bridge) stays connected:
//       register {token, sessionId, cwd}, reply {text}, permission_request {...}
//       <- inbound {text, user}, permission {request_id, behavior}
//   - bridge-hook.js makes one-shot calls: mirror {token, sessionIds, kind, text}
// and it emits the host-neutral events every adapter emits (see daemon.mjs):
//   up {id, cwd, preexisting, backlog}, prompt {id, text}, final {id, text},
//   approval {id, ref, summary, answerable}, down {id}.
// A hook call names the session's current id and the id its process started with (the
// channel registered under the latter; /clear mints a new current one), and is held briefly
// when it beats the channel's registration. CLAUDE_PID is not usable: a nested `claude`
// inherits its parent's.

import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';

const AUTH_TIMEOUT_MS = 5000;
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
    this.sessions = new Map();   // sessionId -> { peer, socket, replies, humanTurn }
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
    const peer = new JsonRpcPeer((t) => socket.write(t + '\n'), {
      onRequest: (method, p = {}) => {
        if (method === 'register') {
          if (!this.#tokenOk(p.token) || !p.sessionId) throw unauthorized();
          clearTimeout(authTimer);
          sessionId = String(p.sessionId);
          const previous = this.sessions.get(sessionId);
          if (previous) {
            this.#withdrawApprovals(sessionId, previous);
            previous.socket.destroy();
          }
          this.sessions.set(sessionId, { peer, socket, replies: [], approvals: new Set(), claudePid: Number(p.claudePid) || null });
          this.emit('up', { id: sessionId, cwd: p.cwd, preexisting: false, backlog: [] });
          this.#release();
          return { ok: true };
        }
        if (method === 'mirror') {
          if (!this.#tokenOk(p.token)) throw unauthorized();
          if (p.kind !== 'prompt' && p.kind !== 'final') throw Object.assign(new Error('bad kind'), { code: -32602 });
          const routed = this.#mirror({ sessionIds: (Array.isArray(p.sessionIds) ? p.sessionIds : []).map(String),
            claudePid: Number(p.claudePid) || null, retry: p.retry === true, kind: p.kind, ...(p.status === 'failed' ? { status: 'failed' } : {}), text: String(p.text ?? '') });
          return { ok: true, routed };
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
      if (sessionId && this.sessions.get(sessionId)?.socket === socket) {
        this.#withdrawApprovals(sessionId, this.sessions.get(sessionId));
        this.sessions.delete(sessionId);
        this.emit('down', { id: sessionId });
      }
    });
  }

  #withdrawApprovals(id, session) {
    // This invalidates bridge controls; it does not claim Claude accepted a verdict.
    for (const ref of session.approvals) this.emit('approval-resolved', { id, ref, reason: 'correlation-withdrawn' });
    session.approvals.clear();
  }

  #route({ sessionIds, claudePid }) {
    const byId = sessionIds.find((id) => this.sessions.has(id));
    if (byId || !claudePid) return byId ?? null;
    // After /clear no id matches; the claude process that owns the channel still does.
    for (const [id, s] of this.sessions) if (s.claudePid === claudePid) return id;
    return null;
  }

  #mirror(m) {
    const id = this.#route(m);
    if (!id) {
      // Held in case its channel has not registered yet; a retry's first copy already is.
      const now = this.now();
      this.held = [...this.held.filter((h) => now - h.at < HOLD_MS), ...(m.retry ? [] : [{ m, at: now }])];
      return false;
    }
    // A retry routed by process: its unroutable first copy must not be released later.
    if (m.retry) this.held = this.held.filter((h) => !(h.m.kind === m.kind && h.m.text === m.text));
    // Only human-initiated turns are mirrored: a prompt typed locally or sent from Telegram.
    // Envelope prompts, and Stop-hook continuations (a final with no prompt since the last
    // one), are the harness talking to itself.
    const s = this.sessions.get(id);
    if (m.kind === 'prompt') {
      s.humanTurn = !isEnvelope(m.text);
      if (s.humanTurn) this.emit('prompt', { id, text: unwrapChannel(m.text) });
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
  }

  status(id) { return this.sessions.has(id) ? 'channel connected' : 'channel disconnected'; }

  answerApproval(ref, allow, id) {
    const s = this.sessions.get(id);
    if (!s || s.socket.destroyed || !s.approvals.delete(ref)) return false;
    s.peer.notify('permission', { request_id: ref, behavior: allow ? 'allow' : 'deny' });
    return true;
  }
}
