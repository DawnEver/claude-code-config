// scripts/bridge/ws-stream.mjs — a minimal RFC 6455 WebSocket *client* over an existing
// byte stream.
//
// Why this exists: `codex app-server proxy` relays raw bytes between stdio and the daemon's
// control socket, and the daemon speaks WebSocket on that socket (verified 2026-10-01,
// codex-cli 0.159.3: newline JSON is answered with a connection reset; an HTTP Upgrade is
// answered with `101 Switching Protocols`). Node's global WebSocket needs a URL, not a
// stream, so we frame by hand. Text frames only; the client masks, the server does not.

import crypto from 'crypto';
import { EventEmitter } from 'events';

const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** Encode one frame. Client->server frames must be masked (RFC 6455 §5.3). */
export function encodeFrame(payload, { opcode = OP.text, mask = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  const head = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 0xff);
  else {
    head.push(m | 127);
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(len));
    head.push(...b);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, out]);
}

/** Incremental frame decoder: push bytes, get back complete frames. */
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const keyLen = masked ? 4 : 0;
      if (b.length < off + keyLen + len) break;
      let payload = b.subarray(off + keyLen, off + keyLen + len);
      if (masked) {
        const key = b.subarray(off, off + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ key[i & 3]));
      } else payload = Buffer.from(payload);
      frames.push({ fin, opcode, payload });
      this.buf = b.subarray(off + keyLen + len);
    }
    return frames;
  }
}

/**
 * WebSocket client over a (readable, writable) pair, e.g. a child's stdout/stdin.
 * Emits 'open', 'message' (string), 'close'. Call `send(text)` after 'open'.
 */
export class WsStreamClient extends EventEmitter {
  constructor(readable, writable, { host = 'localhost', path = '/' } = {}) {
    super();
    this.writable = writable;
    this.decoder = new FrameDecoder();
    this.open = false;
    this.pending = Buffer.alloc(0);
    this.fragments = [];
    this.key = crypto.randomBytes(16).toString('base64');
    readable.on('data', (c) => this.#onData(c));
    readable.on('end', () => this.#closed());
    readable.on('close', () => this.#closed());
    // Deferred so 'open' can never fire inside the constructor, before listeners attach.
    setImmediate(() => writable.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  }

  #onData(chunk) {
    if (!this.open) {
      this.pending = Buffer.concat([this.pending, chunk]);
      const end = this.pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.pending.subarray(0, end).toString('latin1');
      const rest = this.pending.subarray(end + 4);
      this.pending = Buffer.alloc(0);
      const expect = crypto.createHash('sha1')
        .update(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(expect.toLowerCase())) {
        this.emit('error', new Error(`websocket handshake failed: ${head.split('\r\n')[0]}`));
        return this.#closed();
      }
      this.open = true;
      this.emit('open');
      if (rest.length) this.#frames(rest);
      return;
    }
    this.#frames(chunk);
  }

  #frames(chunk) {
    for (const f of this.decoder.push(chunk)) {
      if (f.opcode === OP.ping) { this.#write(encodeFrame(f.payload, { opcode: OP.pong })); continue; }
      if (f.opcode === OP.pong) continue;
      if (f.opcode === OP.close) { this.#closed(); continue; }
      this.fragments.push(f.payload);
      if (!f.fin) continue;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.emit('message', text);
    }
  }

  #write(buf) { try { this.writable.write(buf); } catch { /* stream already gone */ } }

  #closed() {
    if (this.done) return;
    this.done = true;
    this.open = false;
    this.emit('close');
  }

  send(text) { this.#write(encodeFrame(text)); }

  close() { this.#write(encodeFrame(Buffer.alloc(0), { opcode: OP.close })); this.#closed(); }
}
