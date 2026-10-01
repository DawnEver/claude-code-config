// scripts/bridge/claude-adapter.mjs — Claude sessions as one bridge host (docs/bridge.md).
//
// Claude has no shared daemon, so two things dial in here over 127.0.0.1 (newline
// JSON-RPC, random port, token in ~/.claude/bridge/runtime.json):
//   - each session's session-bridge channel (claude_plugins/session-bridge) stays connected:
//       register {token, sessionId, cwd, claudePid}, reply {text}, permission_request {...}
//       <- inbound {text, user}, permission {request_id, behavior}
//   - bridge-hook.js makes one-shot calls: mirror {token, claudePid, sessionId, kind, text}
// and it emits the host-neutral events every adapter emits (see daemon.mjs):
//   up {id, cwd, preexisting, backlog}, prompt {id, text}, final {id, text},
//   approval {id, ref, summary, answerable}, down {id}.
// A hook call is routed by CLAUDE_PID (stable across /clear, which mints a new session id),
// else by session id, and held briefly when it beats the channel's registration.

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

export class ClaudeAdapter extends EventEmitter {
  constructor({ token = crypto.randomBytes(24).toString('hex'), now = Date.now } = {}) {
    super();
    this.agent = 'claude';
    this.token = token;
    this.now = now;
    this.sessions = new Map();   // sessionId -> { peer, socket, claudePid, replies }
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
          this.sessions.get(sessionId)?.socket.destroy();
          this.sessions.set(sessionId, { peer, socket, claudePid: Number(p.claudePid) || null, replies: [] });
          this.emit('up', { id: sessionId, cwd: p.cwd, preexisting: false, backlog: [] });
          this.#release();
          return { ok: true };
        }
        if (method === 'mirror') {
          if (!this.#tokenOk(p.token)) throw unauthorized();
          if (p.kind !== 'prompt' && p.kind !== 'final') throw Object.assign(new Error('bad kind'), { code: -32602 });
          this.#mirror({ claudePid: Number(p.claudePid) || null, sessionId: p.sessionId ?? null, kind: p.kind, text: String(p.text ?? '') });
          return { ok: true };
        }
        if (!sessionId) throw unauthorized();
        if (method === 'reply') {
          const text = String(p.text ?? '');
          this.sessions.get(sessionId)?.replies.push(text.trim());
          this.emit('final', { id: sessionId, text });
          return { ok: true };
        }
        if (method === 'permission_request') {
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
        this.sessions.delete(sessionId);
        this.emit('down', { id: sessionId });
      }
    });
  }

  #route({ claudePid, sessionId }) {
    if (claudePid) for (const [id, s] of this.sessions) if (s.claudePid === claudePid) return id;
    return sessionId && this.sessions.has(sessionId) ? sessionId : null;
  }

  #mirror(m) {
    const id = this.#route(m);
    if (!id) {
      const now = this.now();
      this.held = [...this.held.filter((h) => now - h.at < HOLD_MS), { m, at: now }];
      return;
    }
    if (m.kind === 'prompt') { this.emit('prompt', { id, text: unwrapChannel(m.text) }); return; }
    // The model may already have sent this answer with the reply tool.
    const s = this.sessions.get(id);
    const dup = s.replies.includes(m.text.trim());
    s.replies = [];
    if (m.text.trim() && !dup) this.emit('final', { id, text: m.text });
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
  }

  status(id) { return this.sessions.has(id) ? 'channel connected' : 'channel disconnected'; }

  answerApproval(ref, allow, id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.peer.notify('permission', { request_id: ref, behavior: allow ? 'allow' : 'deny' });
    return true;
  }
}
