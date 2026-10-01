import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { ClaudeAdapter, unwrapChannel } from './claude-adapter.mjs';

/** Drive the adapter over real TCP like the channel and the hook do. */
async function rig() {
  const a = new ClaudeAdapter();
  const port = await a.listen(0);
  const events = [];
  for (const k of ['up', 'prompt', 'final', 'down']) a.on(k, (e) => events.push([k, e]));
  const rpc = (sock, method, params) => new Promise((resolve) => {
    let buf = '';
    const onData = (d) => { buf += d; if (buf.includes('\n')) { sock.off('data', onData); resolve(JSON.parse(buf)); } };
    sock.on('data', onData);
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { token: a.token, ...params } }) + '\n');
  });
  const open = () => new Promise((r) => { const s = net.connect({ host: '127.0.0.1', port }); s.setEncoding('utf8'); s.once('connect', () => r(s)); });
  const hook = async (params) => { const s = await open(); const res = await rpc(s, 'mirror', params); s.destroy(); return res; };
  return { a, events, rpc, open, hook };
}

test('unwrapChannel returns the text of a channel prompt, anything else unchanged', () => {
  assert.equal(unwrapChannel('<channel source="session-bridge" user="u">\nhello\n</channel>'), 'hello');
  assert.equal(unwrapChannel('plain'), 'plain');
});

test('mirror calls route by claude pid across /clear, are held before register, and finals dedupe against reply', async () => {
  const r = await rig();
  try {
    await r.hook({ claudePid: 42, sessionId: 'uuid-1', kind: 'prompt', text: 'early' });
    assert.deepEqual(r.events, [], 'held until the channel registers');
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'uuid-1', cwd: '/repo', claudePid: 42 });
    await r.hook({ claudePid: 42, sessionId: 'uuid-2', kind: 'prompt', text: '<channel source="session-bridge" user="u">from phone</channel>' });
    await r.rpc(ch, 'reply', { text: 'done' });
    await r.hook({ claudePid: 42, kind: 'final', text: 'done\n' });
    await r.hook({ claudePid: 42, kind: 'final', text: '  ' });
    await r.hook({ claudePid: 42, kind: 'final', text: 'second turn' });
    assert.deepEqual(r.events.map(([k, e]) => [k, e.id, e.text]), [
      ['up', 'uuid-1', undefined],
      ['prompt', 'uuid-1', 'early'],
      ['prompt', 'uuid-1', 'from phone'],
      ['final', 'uuid-1', 'done'],
      ['final', 'uuid-1', 'second turn'],
    ]);
    ch.destroy();
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(r.events.at(-1), ['down', { id: 'uuid-1' }]);
  } finally { await r.a.close(); }
});

test('inject and status report a disconnected channel; there is no interrupt', async () => {
  const a = new ClaudeAdapter();
  await assert.rejects(a.inject('nope', 'x'), /channel disconnected/);
  assert.equal(a.status('nope'), 'channel disconnected');
  assert.equal(a.interrupt, undefined);
});
