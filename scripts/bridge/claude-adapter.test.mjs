import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { ClaudeAdapter, unwrapChannel, isEnvelope } from './claude-adapter.mjs';

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

test('mirror calls route by session id, are held before register, never cross sessions, and dedupe against reply', async () => {
  const r = await rig();
  try {
    await r.hook({ sessionIds: ['uuid-1'], kind: 'prompt', text: 'early' });
    assert.deepEqual(r.events, [], 'held until the channel registers');
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'uuid-1', cwd: '/repo' });
    // A nested session (e.g. `claude -p` run from inside another session) is its own session.
    const parent = await r.open();
    await r.rpc(parent, 'register', { sessionId: 'parent', cwd: '/repo' });
    // After /clear the hook's current id is new; the id the process started with still matches.
    await r.hook({ sessionIds: ['uuid-2', 'uuid-1'], kind: 'prompt', text: '<channel source="session-bridge" user="u">from phone</channel>' });
    await r.rpc(ch, 'reply', { text: 'done' });
    await r.hook({ sessionIds: ['uuid-1'], kind: 'final', text: 'done\n' });
    await r.hook({ sessionIds: ['uuid-1'], kind: 'final', text: '  ' });
    await r.hook({ sessionIds: ['parent'], kind: 'prompt', text: 'parent question' });
    await r.hook({ sessionIds: ['parent'], kind: 'final', text: 'parent answer' });
    await r.hook({ sessionIds: ['uuid-1'], kind: 'prompt', text: 'q2' });
    await r.hook({ sessionIds: ['uuid-1'], kind: 'final', text: 'second turn' });
    await r.hook({ sessionIds: ['stranger'], kind: 'final', text: 'nobody' });
    assert.deepEqual(r.events.map(([k, e]) => [k, e.id, e.text]), [
      ['up', 'uuid-1', undefined],
      ['prompt', 'uuid-1', 'early'],
      ['up', 'parent', undefined],
      ['prompt', 'uuid-1', 'from phone'],
      ['final', 'uuid-1', 'done'],
      ['prompt', 'parent', 'parent question'],
      ['final', 'parent', 'parent answer'],
      ['prompt', 'uuid-1', 'q2'],
      ['final', 'uuid-1', 'second turn'],
    ]);
    ch.destroy(); parent.destroy();
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(r.events.filter(([k]) => k === 'down').map(([, e]) => e.id).sort(), ['parent', 'uuid-1']);
  } finally { await r.a.close(); }
});

test('isEnvelope: harness/plugin injections only, never a prompt that merely mentions a tag', () => {
  for (const t of [
    '<agent-message from="a2cc">[Subagent hand-back] done</agent-message>',
    '<task-notification>\n<task-id>x</task-id>\n</task-notification>',
    '  <system-reminder>note</system-reminder>\n',
    '<system-reminder>a</system-reminder>\n<task-notification>b</task-notification>',
    'Stop hook feedback:\nrun the review',
  ]) assert.equal(isEnvelope(t), true, t);
  for (const t of [
    'why does <system-reminder> show up in my transcript?',
    'fix the <agent-message> parser\n<agent-message>x</agent-message>',
    'plain prompt',
  ]) assert.equal(isEnvelope(t), false, t);
});

test('envelope prompts and the finals of turns they (or a Stop hook) triggered are not mirrored', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', cwd: '/repo' });
    const ids = ['s'];
    await r.hook({ sessionIds: ids, kind: 'prompt', text: 'human question' });
    await r.hook({ sessionIds: ids, kind: 'final', text: 'human answer' });
    await r.hook({ sessionIds: ids, kind: 'final', text: 'stop-hook continuation' });
    await r.hook({ sessionIds: ids, kind: 'prompt', text: '<agent-message from="x">hand-back</agent-message>' });
    await r.hook({ sessionIds: ids, kind: 'final', text: 'reaction to the hand-back' });
    await r.a.inject('s', 'from phone', 'u');   // a Telegram turn counts even if its prompt never mirrors
    await r.hook({ sessionIds: ids, kind: 'final', text: 'phone answer' });
    assert.deepEqual(r.events.filter(([k]) => k !== 'up').map(([k, e]) => [k, e.text]), [
      ['prompt', 'human question'], ['final', 'human answer'], ['final', 'phone answer'],
    ]);
    ch.destroy();
  } finally { await r.a.close(); }
});

test('inject and status report a disconnected channel; there is no interrupt', async () => {
  const a = new ClaudeAdapter();
  await assert.rejects(a.inject('nope', 'x'), /channel disconnected/);
  assert.equal(a.status('nope'), 'channel disconnected');
  assert.equal(a.interrupt, undefined);
});
