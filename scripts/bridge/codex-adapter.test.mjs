import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, progressLine, probeDaemon, backlogSince } from './codex-adapter.mjs';

/** Fake app-server behind the adapter's transport interface. */
function fakeAppServer({ loaded = ['t1'], threads = {} } = {}) {
  const calls = [];
  const responses = [];
  let onMsg, onClose;
  const t = {
    onOpen: (fn) => setImmediate(fn),
    onMessage: (fn) => { onMsg = fn; },
    onClose: (fn) => { onClose = fn; },
    send: (s) => {
      const m = JSON.parse(s);
      if (m.method === undefined) { responses.push(m); return; }
      calls.push(m);
      if (m.id === undefined) return;
      const fail = m.method === 'thread/resume' && threads[m.params?.threadId]?.error;
      if (fail) { setImmediate(() => onMsg(JSON.stringify({ id: m.id, error: { code: -32600, message: fail } }))); return; }
      const result = {
        initialize: { userAgent: 'fake' },
        'thread/loaded/list': { data: loaded, nextCursor: null },
        'thread/resume': { thread: threads[m.params?.threadId] ?? { id: m.params?.threadId, cwd: '/w', ephemeral: false, gitInfo: { branch: 'feat/x' }, turns: [] } },
        'turn/start': { turn: { id: 'turnA' } },
        'turn/steer': { turnId: 'turnA' },
        'turn/interrupt': {},
      }[m.method];
      setImmediate(() => onMsg(JSON.stringify({ id: m.id, result })));
    },
    close: () => onClose?.(),
  };
  return {
    transport: t, calls, responses,
    push: (method, params) => onMsg(JSON.stringify({ method, params })),
    request: (id, method, params) => onMsg(JSON.stringify({ id, method, params })),
    setLoaded: (l) => { loaded = l; },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

async function started(opts) {
  const srv = fakeAppServer(opts);
  const a = new CodexAdapter({ connect: () => srv.transport, probe: async () => ({ status: 'running' }) });
  const ups = [];
  a.on('session-up', (s) => ups.push(s));
  assert.equal(await a.start(), true);
  await a.refresh();
  return { a, srv, ups };
}

test('start() returns false when the daemon probe fails, without connecting', async () => {
  let connected = false;
  const a = new CodexAdapter({ connect: () => { connected = true; }, probe: async () => null });
  assert.equal(await a.start(), false);
  assert.equal(connected, false);
});

test('handshake then subscribe every loaded thread via thread/resume', async () => {
  const { srv, ups } = await started();
  assert.deepEqual(srv.calls.map((c) => c.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/resume']);
  assert.deepEqual(ups, [{ threadId: 't1', cwd: '/w', branch: 'feat/x', name: null, preexisting: true, backlog: [] }]);
});

test('ephemeral threads are skipped; unloaded threads go down on refresh', async () => {
  const { a, srv, ups } = await started({ loaded: ['t1', 'e1'], threads: { e1: { id: 'e1', ephemeral: true } } });
  assert.deepEqual(ups.map((u) => u.threadId), ['t1']);
  const downs = [];
  a.on('session-down', (d) => downs.push(d.threadId));
  srv.setLoaded([]);
  await a.refresh();
  assert.deepEqual(downs, ['t1']);
});

test('deltas aggregate; final message is emitted on turn/completed; progress per item', async () => {
  const { a, srv } = await started();
  const finals = [], progress = [];
  a.on('final', (f) => finals.push(f));
  a.on('progress', (p) => progress.push(p.text));
  srv.push('turn/started', { threadId: 't1', turn: { id: 'turnA' } });
  assert.match(a.status('t1'), /in progress/);
  srv.push('item/agentMessage/delta', { threadId: 't1', turnId: 'turnA', itemId: 'i1', delta: 'Hel' });
  srv.push('item/agentMessage/delta', { threadId: 't1', turnId: 'turnA', itemId: 'i1', delta: 'lo' });
  srv.push('item/completed', { threadId: 't1', turnId: 'turnA', item: { type: 'commandExecution', id: 'c', command: 'npm test', exitCode: 0 } });
  srv.push('turn/completed', { threadId: 't1', turn: { id: 'turnA', status: 'completed' } });
  assert.deepEqual(progress, ['$ npm test (exit 0)']);
  assert.deepEqual(finals, [{ threadId: 't1', status: 'completed', text: 'Hello' }]);
  assert.equal(a.status('t1'), 'idle');
});

test('backlogSince replays only turns started after the bridge connected', () => {
  const turns = [
    { startedAt: 100, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'old' }] }] },
    { startedAt: 200, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }, { type: 'agentMessage', text: 'Hello!' }] },
    { startedAt: 201, status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'next' }] }] },
  ];
  assert.deepEqual(backlogSince(turns, 150_000), [
    { kind: 'prompt', text: 'hi' }, { kind: 'final', text: 'Hello!', status: 'completed' }, { kind: 'prompt', text: 'next' }]);
  assert.deepEqual(backlogSince(turns, Infinity), []);
});

test('thread/started subscribes at once, once, and carries the backlog', async () => {
  const fresh = { id: 't2', cwd: '/w', ephemeral: false, turns: [
    { startedAt: Math.floor(Date.now() / 1000) + 5, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }, { type: 'agentMessage', text: 'Hello!' }] }] };
  const { a, srv, ups } = await started({ loaded: [], threads: { t2: fresh } });
  srv.push('thread/started', { thread: { id: 't2', ephemeral: false } });
  srv.setLoaded(['t2']);
  await a.refresh();
  await tick(); await tick();
  assert.equal(srv.calls.filter((c) => c.method === 'thread/resume').length, 1, 'resumed once despite the race');
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0].backlog, [{ kind: 'prompt', text: 'hi' }, { kind: 'final', text: 'Hello!', status: 'completed' }]);
});

test('an ephemeral thread that cannot be resumed is not retried every poll', async () => {
  const { a, srv } = await started({ loaded: ['eph'], threads: { eph: { error: 'no rollout found for thread id eph' } } });
  const warns = [];
  a.on('warn', (w) => warns.push(w));
  await a.refresh(); await a.refresh();
  assert.equal(srv.calls.filter((c) => c.method === 'thread/resume').length, 1);
  assert.deepEqual(warns, []);
});

test('a completed userMessage item is emitted as the prompt text', async () => {
  const { a, srv } = await started();
  const prompts = [];
  a.on('prompt', (p) => prompts.push(p));
  srv.push('item/completed', { threadId: 't1', item: { type: 'userMessage', id: 'u', content: [
    { type: 'text', text: 'fix the build' }, { type: 'image', url: 'x' }] } });
  srv.push('item/completed', { threadId: 't1', item: { type: 'userMessage', id: 'v', content: [{ type: 'image', url: 'x' }] } });
  assert.deepEqual(prompts, [{ threadId: 't1', text: 'fix the build' }]);
});

test('inject uses turn/start when idle and turn/steer with expectedTurnId mid-turn', async () => {
  const { a, srv } = await started();
  assert.equal(await a.inject('t1', 'hi'), 'started');
  assert.deepEqual(srv.calls.at(-1).params, { threadId: 't1', input: [{ type: 'text', text: 'hi', text_elements: [] }] });
  srv.push('turn/started', { threadId: 't1', turn: { id: 'turnB' } });
  assert.equal(await a.inject('t1', 'more'), 'steered');
  assert.equal(srv.calls.at(-1).method, 'turn/steer');
  assert.equal(srv.calls.at(-1).params.expectedTurnId, 'turnB');
  assert.equal(await a.interrupt('t1'), true);
  assert.deepEqual(srv.calls.at(-1).params, { threadId: 't1', turnId: 'turnB' });
});

test('approvals are relayed and never answered unless answerApproval is called', async () => {
  const { a, srv } = await started();
  const seen = [], resolved = [];
  a.on('approval', (x) => seen.push(x));
  a.on('approval-resolved', (x) => resolved.push(x.key));
  srv.request(77, 'item/commandExecution/requestApproval', { threadId: 't1', turnId: 'x', itemId: 'i', command: 'rm -rf build' });
  srv.request(78, 'item/permissions/requestApproval', { threadId: 't1' });
  srv.request(79, 'account/chatgptAuthTokens/refresh', {});
  await tick();
  assert.deepEqual(seen.map((s) => [s.key, s.answerable, s.summary]), [['c77', true, '$ rm -rf build'], ['c78', false, 'item/permissions/requestApproval']]);
  assert.deepEqual(srv.responses, [], 'nothing answered automatically');
  assert.equal(a.answerApproval('c78', true), false, 'non accept/decline shapes are never answered');
  assert.equal(a.answerApproval('c77', false), true);
  assert.deepEqual(srv.responses, [{ jsonrpc: '2.0', id: 77, result: { decision: 'decline' } }]);
  srv.request(80, 'item/fileChange/requestApproval', { threadId: 't1' });
  await tick();
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 80 });
  assert.deepEqual(resolved, ['c80']);
  assert.equal(a.answerApproval('c80', true), false, 'answered elsewhere first');
});

test('transport close drops every session', async () => {
  const { a, srv } = await started();
  const downs = [];
  a.on('session-down', (d) => downs.push(d.threadId));
  srv.transport.close();
  assert.deepEqual(downs, ['t1']);
  assert.equal(a.connected, false);
});

test('progressLine ignores chatter items', () => {
  assert.equal(progressLine({ type: 'reasoning' }), null);
  assert.equal(progressLine({ type: 'fileChange', changes: [{}, {}] }), 'edited 2 files');
});

// Real local app-server: initialize + thread/loaded/list only — no model call, no turn.
test('integration: real codex app-server answers initialize and thread/loaded/list', async (t) => {
  if (process.env.BRIDGE_SKIP_CODEX_IT) return t.skip('BRIDGE_SKIP_CODEX_IT set');
  const v = await probeDaemon();
  if (!v) return t.skip('codex app-server daemon not running (codex app-server daemon version)');
  const a = new CodexAdapter({ clientName: 'cc-config-bridge-test' });
  try {
    assert.equal(await a.start(), true);
    const r = await a.rpc.request('thread/loaded/list', {});
    assert.ok(Array.isArray(r.data));
  } finally { a.stop(); }
});
