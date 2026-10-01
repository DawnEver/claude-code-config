import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { PassThrough } from 'stream';
import { encodeFrame, FrameDecoder, WsStreamClient } from './ws-stream.mjs';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';

test('frames round-trip at every length class, masked and unmasked', () => {
  for (const n of [0, 5, 125, 126, 70000]) {
    for (const mask of [true, false]) {
      const payload = Buffer.alloc(n, 'x');
      const [f] = new FrameDecoder().push(encodeFrame(payload, { mask }));
      assert.equal(f.payload.length, n);
      assert.ok(f.fin);
      assert.equal(f.opcode, 1);
    }
  }
});

test('decoder buffers partial frames', () => {
  const d = new FrameDecoder();
  const buf = encodeFrame('hello', { mask: false });
  assert.deepEqual(d.push(buf.subarray(0, 3)), []);
  assert.equal(d.push(buf.subarray(3))[0].payload.toString(), 'hello');
});

/** A fake server end: answers the upgrade, then speaks unmasked frames. */
function fakeServer() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const dec = new FrameDecoder();
  const received = [];
  let shook = false;
  fromClient.on('data', (c) => {
    if (!shook) {
      const key = /Sec-WebSocket-Key: (\S+)/.exec(c.toString())[1];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      shook = true;
      toClient.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
      return;
    }
    for (const f of dec.push(c)) received.push(f);
  });
  return { toClient, fromClient, received, send: (t, o) => toClient.write(encodeFrame(t, { mask: false, ...o })) };
}

test('client handshakes, reassembles fragments, answers ping', async () => {
  const srv = fakeServer();
  const ws = new WsStreamClient(srv.toClient, srv.fromClient);
  await new Promise((r) => ws.once('open', r));
  const got = new Promise((r) => ws.once('message', r));
  const a = encodeFrame('hel', { mask: false }); a[0] &= 0x7f;            // FIN off
  const b = encodeFrame('lo', { mask: false, opcode: 0 });               // continuation
  srv.toClient.write(Buffer.concat([a, b]));
  assert.equal(await got, 'hello');
  srv.send('p', { opcode: 0x9 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.received.at(-1).opcode, 0xa);
  ws.send('{"x":1}');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.received.at(-1).payload.toString(), '{"x":1}');
});

test('handshake rejection emits error and close', async () => {
  const toClient = new PassThrough();
  const ws = new WsStreamClient(toClient, new PassThrough());
  const err = new Promise((r) => ws.once('error', r));
  toClient.write('HTTP/1.1 400 Bad Request\r\n\r\n');
  assert.match((await err).message, /handshake failed/);
});

test('JsonRpcPeer pairs responses, routes requests and notifications', async () => {
  const out = [];
  const notes = [];
  const peer = new JsonRpcPeer((t) => out.push(JSON.parse(t)), {
    onRequest: (m, p) => (m === 'add' ? p.a + p.b : undefined),
    onNotification: (m, p) => notes.push([m, p]),
  });
  const pr = peer.request('x', { y: 1 });
  await peer.receive(JSON.stringify({ id: out[0].id, result: 42 }));
  assert.equal(await pr, 42);
  const pe = peer.request('bad');
  await peer.receive(JSON.stringify({ id: out[1].id, error: { code: 1, message: 'nope' } }));
  await assert.rejects(pe, /nope/);
  await peer.receive(JSON.stringify({ id: 9, method: 'add', params: { a: 1, b: 2 } }));
  assert.deepEqual(out.at(-1), { jsonrpc: '2.0', id: 9, result: 3 });
  await peer.receive(JSON.stringify({ method: 'ev', params: { k: 1 } }));
  assert.deepEqual(notes, [['ev', { k: 1 }]]);
  const pf = peer.request('z');
  peer.failAll();
  await assert.rejects(pf, /closed/);
});

test('lineSplitter handles split and CRLF lines', () => {
  const got = [];
  const feed = lineSplitter((l) => got.push(l));
  feed('a\r\nb'); feed('c\n\n');
  assert.deepEqual(got, ['a', 'bc']);
});
