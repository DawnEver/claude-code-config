// scripts/bridge/channel-hub.mjs — the daemon's localhost endpoint for Claude sessions.
//
// Claude has no shared daemon, so each Claude session runs the session-bridge channel MCP
// server (claude_plugins/session-bridge), which dials in here. Transport: newline-delimited
// JSON-RPC over TCP bound to 127.0.0.1 only, on a random port. The port and a fresh random
// token go into ~/.claude/bridge/runtime.json (0600); a connection that does not present
// the token as its first `register` call is dropped.
//
// channel -> hub:  register {token, sessionId, cwd, branch}, reply {text}, permission_request {...}
// hub -> channel:  inbound {text, user}, permission {request_id, behavior}

import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';

export class ChannelHub extends EventEmitter {
  constructor({ token = crypto.randomBytes(24).toString('hex') } = {}) {
    super();
    this.token = token;
    this.sessions = new Map();   // sessionId -> { peer, socket, cwd, branch }
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

  #onSocket(socket) {
    let sessionId = null;
    const authTimer = setTimeout(() => { if (!sessionId) socket.destroy(); }, 5000);
    authTimer.unref();
    const peer = new JsonRpcPeer((t) => socket.write(t + '\n'), {
      onRequest: (method, p = {}) => {
        if (method === 'register') {
          const ok = typeof p.token === 'string' && p.token.length === this.token.length &&
            crypto.timingSafeEqual(Buffer.from(p.token), Buffer.from(this.token));
          if (!ok || !p.sessionId) { setImmediate(() => socket.destroy()); throw Object.assign(new Error('unauthorized'), { code: 401 }); }
          clearTimeout(authTimer);
          sessionId = String(p.sessionId);
          this.sessions.get(sessionId)?.socket.destroy();
          this.sessions.set(sessionId, { peer, socket, cwd: p.cwd, branch: p.branch });
          this.emit('session-up', { sessionId, cwd: p.cwd, branch: p.branch ?? null });
          return { ok: true };
        }
        if (!sessionId) throw Object.assign(new Error('unauthorized'), { code: 401 });
        if (method === 'reply') {
          this.emit('reply', { sessionId, text: String(p.text ?? '') });
          return { ok: true };
        }
        if (method === 'permission_request') {
          this.emit('permission', { sessionId, ...p });
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
        this.emit('session-down', { sessionId });
      }
    });
  }

  deliver(sessionId, text, user) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.peer.notify('inbound', { text, user: user ?? '' });
    return true;
  }

  verdict(sessionId, requestId, allow) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.peer.notify('permission', { request_id: requestId, behavior: allow ? 'allow' : 'deny' });
    return true;
  }
}
