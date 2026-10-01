// scripts/bridge/jsonrpc.mjs — a transport-agnostic JSON-RPC 2.0 peer.
//
// Used three ways: the Codex app-server (over WebSocket text frames), the MCP channel server
// (newline-delimited stdio), and the daemon <-> channel IPC (newline-delimited TCP). The
// peer only needs `send(string)` plus a call to `receive(string)` per incoming message.

export class JsonRpcPeer {
  /**
   * @param {(text: string) => void} send
   * @param {{ onRequest?: (method, params, id) => any, onNotification?: (method, params) => void,
   *           timeoutMs?: number, jsonrpcField?: boolean }} opts
   */
  constructor(send, { onRequest, onNotification, timeoutMs = 30000, jsonrpcField = true } = {}) {
    this.sendRaw = send;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.timeoutMs = timeoutMs;
    this.jsonrpcField = jsonrpcField;
    this.nextId = 1;
    this.pending = new Map();
  }

  #out(msg) { this.sendRaw(JSON.stringify(this.jsonrpcField ? { jsonrpc: '2.0', ...msg } : msg)); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = this.timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timed out`)); }, this.timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.#out({ id, method, params });
    });
  }

  notify(method, params) { this.#out(params === undefined ? { method } : { method, params }); }

  respond(id, result) { this.#out({ id, result }); }

  respondError(id, code, message) { this.#out({ id, error: { code, message } }); }

  async receive(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      if (!this.onRequest) return this.respondError(msg.id, -32601, `method not found: ${msg.method}`);
      try {
        const result = await this.onRequest(msg.method, msg.params, msg.id);
        if (result !== undefined) this.respond(msg.id, result);   // undefined = answered later / never
      } catch (e) {
        this.respondError(msg.id, e.code ?? -32603, e.message);
      }
      return;
    }
    this.onNotification?.(msg.method, msg.params);
  }

  /** Reject every in-flight request, e.g. when the transport closes. */
  failAll(reason = 'connection closed') {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: ${reason}`));
      this.pending.delete(id);
    }
  }
}

/** Split a byte/char stream into newline-delimited messages. */
export function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}
