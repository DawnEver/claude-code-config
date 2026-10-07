import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, progressLine, probeDaemon, backlogSince, isMainSession } from './codex-adapter.mjs';

/** Fake app-server behind the adapter's transport interface. */
function fakeAppServer({ loaded = ['t1'], threads = {}, beforeReply } = {}) {
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
      if (beforeReply?.(m, onMsg)) return;
      const spec = threads[m.params?.threadId];
      // A fresh thread: resume AND read both fail until the rollout exists (real Codex behaviour).
      const resumeFails = m.method === 'thread/resume' && spec?.error && (spec.failTimes ?? Infinity) > 0;
      const readFails = m.method === 'thread/read' && spec?.readFails && (spec.failTimes ?? Infinity) > 0;
      const fail = (resumeFails || readFails) && spec.error;
      if (resumeFails && spec.failTimes !== undefined) spec.failTimes--;
      if (fail) { setImmediate(() => onMsg(JSON.stringify({ id: m.id, error: { code: -32600, message: fail } }))); return; }
      const result = {
        initialize: { userAgent: 'fake' },
        'thread/loaded/list': { data: loaded, nextCursor: null },
        'thread/resume': { thread: threads[m.params?.threadId] ? { source: 'cli', ...threads[m.params?.threadId] } : { id: m.params?.threadId, source: 'cli', cwd: '/w', ephemeral: false, gitInfo: { branch: 'feat/x' }, turns: [] } },
        'thread/read': { thread: { id: m.params?.threadId, ephemeral: spec?.ephemeral ?? false } },
        'turn/start': { turn: { id: 'turnA' } },
        'turn/steer': { turnId: 'turnA' },
        'turn/interrupt': {},
        'account/read': { account: { type: 'chatgpt', email: 'c@example.com', planType: 'plus' } },
        'account/rateLimits/read': { rateLimitResetCredits: { availableCount: 1, credits: null }, rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 9 } } },
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
  a.on('up', (s) => ups.push(s));
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
  assert.deepEqual(srv.calls.map((c) => c.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'thread/loaded/list', 'thread/resume']);
  assert.deepEqual(ups, [{ id: 't1', cwd: '/w', branch: 'feat/x', backlog: [] }]);
});

test('account quota: read on refresh, replaced by pushes for the codex bucket only', async () => {
  const { a, srv } = await started();
  assert.equal(a.quota.limits.primary.usedPercent, 20);
  assert.deepEqual(a.account, { email: 'c@example.com', plan: 'plus' });
  assert.equal(a.quota.resetCredits.availableCount, 1);
  srv.push('account/rateLimits/updated', { rateLimits: { limitId: 'other', primary: { usedPercent: 99 } } });
  assert.equal(a.quota.limits.primary.usedPercent, 20);
  srv.push('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 9 } } });
  assert.equal(a.quota.limits.primary.usedPercent, 30);
  srv.push('account/rateLimits/updated', { rateLimits: { secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 9 }, primary: null } });
  assert.deepEqual([a.quota.limits.primary.usedPercent, a.quota.limits.secondary.usedPercent], [30, 7], 'a partial push keeps the other window');
  await a.refresh();
  assert.equal(srv.calls.filter((c) => c.method === 'account/rateLimits/read').length, 1, 'not re-read within 5 minutes');
});

test('status follows Codex\'s own thread status, not the adapter\'s turn bookkeeping', async () => {
  const { a, srv } = await started({ threads: { t1: { id: 't1', cwd: '/w', ephemeral: false, gitInfo: { branch: 'main' }, turns: [], status: { type: 'idle' } } } });
  const statuses = [];
  a.on('status', (e) => statuses.push(e.id));
  srv.push('turn/started', { threadId: 't1', turn: { id: 'T' } });   // a turn whose end is never seen
  srv.push('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
  assert.equal(a.statusSnapshot('t1').state, 'idle', 'native idle wins over a stale turn record');
  srv.push('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  assert.equal(a.statusSnapshot('t1').state, 'waiting-approval');
  srv.push('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  assert.equal(a.statusSnapshot('t1').state, 'running');
  srv.push('thread/status/changed', { threadId: 't1', status: { type: 'systemError' } });
  assert.equal(a.statusSnapshot('t1').state, 'unknown');
  assert.ok(statuses.length >= 4);
});

test('ephemeral threads are skipped; unloaded threads go down on refresh', async () => {
  const { a, srv, ups } = await started({ loaded: ['t1', 'e1'], threads: { e1: { id: 'e1', ephemeral: true } } });
  assert.deepEqual(ups.map((u) => u.id), ['t1']);
  const downs = [];
  a.on('down', (d) => downs.push(d.id));
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
  assert.deepEqual(progress, []);
  assert.deepEqual(finals, [{ id: 't1', turnId: 'turnA', status: 'completed', text: 'Hello' }]);
  assert.equal(a.status('t1'), 'idle');
});

test('backlogSince replays only turns started after the bridge connected', () => {
  const turns = [
    { startedAt: 100, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'old' }] }] },
    { id: 'T2', startedAt: 200, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }, { type: 'agentMessage', text: 'Hello!' }] },
    { id: 'T3', startedAt: 201, status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'next' }] }] },
  ];
  assert.deepEqual(backlogSince(turns, 150_000), [
    { kind: 'prompt', text: 'hi', turnId: 'T2' }, { kind: 'final', text: 'Hello!', status: 'completed', turnId: 'T2' }, { kind: 'prompt', text: 'next', turnId: 'T3' }]);
  assert.deepEqual(backlogSince(turns, Infinity), []);
});

test('backlog keeps every message paragraph, commentary included, without duplicate items', () => {
  assert.equal(backlogSince([{ id: 't', startedAt: 2, status: 'completed', items: [
    { type: 'agentMessage', id: 'c', phase: 'commentary', text: 'I will inspect' },
    { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'First paragraph' },
    { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'First paragraph' },
    { type: 'agentMessage', id: 'b', phase: 'final_answer', text: 'Second paragraph' },
  ] }], 0)[0].text, 'I will inspect\n\nFirst paragraph\n\nSecond paragraph');
});

test('live turn keeps every message item in order, commentary included', async () => {
  const { a, srv } = await started(); const finals = [];
  a.on('final', (f) => finals.push(f));
  srv.push('turn/started', { threadId: 't1', turn: { id: 't' } });
  for (const item of [
    { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'First paragraph' },
    { type: 'agentMessage', id: 'b', phase: 'final_answer', text: 'Second paragraph' },
    { type: 'agentMessage', id: 'b', phase: 'final_answer', text: 'Second paragraph' },
    { type: 'agentMessage', id: 'c', phase: 'commentary', text: 'working' },
  ]) srv.push('item/completed', { threadId: 't1', turnId: 't', item });
  srv.push('turn/completed', { threadId: 't1', turn: { id: 't', status: 'completed' } });
  assert.equal(finals[0].text, 'First paragraph\n\nSecond paragraph\n\nworking');
});

test('completed turn snapshot supplies lost items and replaces partial streamed text once', async () => {
  const { a, srv } = await started(); const finals = [];
  a.on('final', (f) => finals.push(f));
  srv.push('turn/started', { threadId: 't1', turn: { id: 't' } });
  srv.push('item/agentMessage/delta', { threadId: 't1', turnId: 't', itemId: 'a', delta: 'Partial' });
  srv.push('turn/completed', { threadId: 't1', turn: { id: 't', status: 'completed', items: [
    { type: 'agentMessage', id: 'c', phase: 'commentary', text: 'working' },
    { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'Complete first paragraph' },
    { type: 'agentMessage', id: 'b', phase: 'final_answer', text: 'Second paragraph' },
  ] } });
  assert.equal(finals[0].text, 'working\n\nComplete first paragraph\n\nSecond paragraph');
});

test('unphased legacy final items are complete and cleared for the next turn', async () => {
  const { a, srv } = await started(); const finals = [];
  a.on('final', (f) => finals.push(f));
  for (const turn of ['one', 'two']) {
    srv.push('turn/started', { threadId: 't1', turn: { id: turn } });
    for (const [id, text] of [['a', 'first'], ['b', 'second']])
      srv.push('item/completed', { threadId: 't1', turnId: turn, item: { type: 'agentMessage', id, text: `${turn} ${text}` } });
    srv.push('turn/completed', { threadId: 't1', turn: { id: turn, status: 'completed' } });
  }
  assert.deepEqual(finals.map((f) => f.text), ['one first\n\none second', 'two first\n\ntwo second']);
});

test('streamed items are complete even when completion notifications are missing', async () => {
  const { a, srv } = await started(); const finals = [];
  a.on('final', (f) => finals.push(f));
  srv.push('turn/started', { threadId: 't1', turn: { id: 't' } });
  for (const [id, phase, text] of [['c', 'commentary', 'working'], ['f', 'final_answer', 'Answer']]) {
    srv.push('item/started', { threadId: 't1', turnId: 't', item: { type: 'agentMessage', id, phase, text: '' } });
    srv.push('item/agentMessage/delta', { threadId: 't1', turnId: 't', itemId: id, delta: text });
  }
  srv.push('turn/completed', { threadId: 't1', turn: { id: 't', status: 'completed' } });
  assert.equal(finals[0].text, 'working\n\nAnswer');
});

test('late old-turn message events never contaminate the current final', async () => {
  const { a, srv } = await started(); const finals = [];
  a.on('final', (f) => finals.push(f));
  srv.push('turn/started', { threadId: 't1', turn: { id: 'new' } });
  srv.push('item/agentMessage/delta', { threadId: 't1', turnId: 'old', itemId: 'old-delta', delta: 'stale delta' });
  srv.push('item/completed', { threadId: 't1', turnId: 'old', item: { type: 'agentMessage', id: 'old-item', text: 'stale item' } });
  srv.push('item/completed', { threadId: 't1', turnId: 'new', item: { type: 'agentMessage', id: 'new-item', text: 'Current answer' } });
  srv.push('turn/completed', { threadId: 't1', turn: { id: 'new', status: 'completed' } });
  assert.equal(finals[0].text, 'Current answer');
});

test('subscribe during a turn preserves answer items already present in native history', async () => {
  const { a, srv } = await started({ threads: { t1: { id: 't1', cwd: '/w', turns: [
    { id: 'running', status: 'inProgress', items: [{ type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'First paragraph' }] },
  ] } } });
  const finals = []; a.on('final', (f) => finals.push(f));
  srv.push('item/completed', { threadId: 't1', turnId: 'running', item: { type: 'agentMessage', id: 'b', phase: 'final_answer', text: 'Second paragraph' } });
  srv.push('turn/completed', { threadId: 't1', turn: { id: 'running', status: 'completed' } });
  assert.equal(finals[0].text, 'First paragraph\n\nSecond paragraph');
});

test('thread/started subscribes at once, once, and carries the backlog', async () => {
  const fresh = { id: 't2', cwd: '/w', ephemeral: false, turns: [
    { startedAt: Math.floor(Date.now() / 1000) + 5, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] }, { type: 'agentMessage', text: 'Hello!' }] }] };
  const { a, srv, ups } = await started({ loaded: [], threads: { t2: fresh } });
  srv.push('thread/started', { thread: { id: 't2', ephemeral: false, source: 'cli' } });
  srv.setLoaded(['t2']);
  await a.refresh();
  await tick(); await tick();
  assert.equal(srv.calls.filter((c) => c.method === 'thread/resume').length, 1, 'resumed once despite the race');
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0].backlog, [{ kind: 'prompt', text: 'hi', turnId: null }, { kind: 'final', text: 'Hello!', status: 'completed', turnId: null }]);
});

test('an ephemeral thread that cannot be resumed is not retried every poll', async () => {
  const { a, srv } = await started({ loaded: ['eph'], threads: { eph: { ephemeral: true, error: 'no rollout found for thread id eph' } } });
  const warns = [];
  a.on('warn', (w) => warns.push(w));
  await a.refresh(); await a.refresh();
  assert.equal(srv.calls.filter((c) => c.method === 'thread/resume').length, 1);
  assert.deepEqual(warns, []);
});

test('a fresh thread whose rollout is not written yet is retried until it subscribes', async () => {
  const srv = fakeAppServer({ loaded: [], threads: { t3: { failTimes: 1, readFails: true, error: 'no rollout found for thread id t3',
    id: 't3', cwd: '/w', ephemeral: false, turns: [] } } });
  const a = new CodexAdapter({ connect: () => srv.transport, probe: async () => ({ status: 'running' }), resumeRetryMs: 5 });
  const ups = [];
  a.on('up', (s) => ups.push(s.id));
  await a.start(); await a.refresh();
  srv.push('thread/started', { thread: { id: 't3', ephemeral: false, source: 'cli' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ups, ['t3']);
  assert.equal(srv.calls.filter((c) => c.method === 'thread/resume').length, 2);
});

test('an empty rollout (the same race, other wording) is retried without a warning', async () => {
  const err = String.raw`thread/resume: failed to read thread: thread-store internal error: failed to read session metadata C:\x\rollout-t4.jsonl: rollout at C:\x\rollout-t4.jsonl is empty`;
  const srv = fakeAppServer({ loaded: [], threads: { t4: { failTimes: 1, readFails: true, error: err, id: 't4', cwd: '/w', ephemeral: false, turns: [] } } });
  const a = new CodexAdapter({ connect: () => srv.transport, probe: async () => ({ status: 'running' }), resumeRetryMs: 5 });
  const ups = [], warns = [];
  a.on('up', (s) => ups.push(s.id));
  a.on('warn', (w) => warns.push(w));
  await a.start(); await a.refresh();
  srv.push('thread/started', { thread: { id: 't4', ephemeral: false, source: 'cli' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual([ups, warns], [['t4'], []]);
});

test('a completed userMessage item is emitted as the prompt text', async () => {
  const { a, srv } = await started();
  const prompts = [];
  a.on('prompt', (p) => prompts.push(p));
  srv.push('item/completed', { threadId: 't1', turnId: 'tu', item: { type: 'userMessage', id: 'u', content: [
    { type: 'text', text: 'fix the build' }, { type: 'image', url: 'x' }] } });
  srv.push('item/completed', { threadId: 't1', item: { type: 'userMessage', id: 'v', content: [{ type: 'image', url: 'x' }] } });
  assert.deepEqual(prompts, [{ id: 't1', turnId: 'tu', text: 'fix the build' }]);
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

test('inbound images use native localImage input for both start and steer', async () => {
  const { a, srv } = await started();
  const images = ['/fixture/photo.png'];
  await a.inject('t1', 'describe image', 'remote', { images });
  assert.deepEqual(srv.calls.at(-1).params.input, [
    { type: 'text', text: 'describe image', text_elements: [] },
    { type: 'localImage', path: images[0] },
  ]);
  srv.push('turn/started', { threadId: 't1', turn: { id: 'turnB' } });
  await a.inject('t1', 'another image', 'remote', { images });
  assert.equal(srv.calls.at(-1).method, 'turn/steer');
  assert.deepEqual(srv.calls.at(-1).params.input.at(-1), { type: 'localImage', path: images[0] });
});

test('approvals are relayed and never answered unless answerApproval is called', async () => {
  const { a, srv } = await started();
  const seen = [], resolved = [];
  a.on('approval', (x) => seen.push(x));
  a.on('approval-resolved', (x) => resolved.push(x.ref));
  srv.request(77, 'item/commandExecution/requestApproval', { threadId: 't1', turnId: 'x', itemId: 'i', command: 'rm -rf build' });
  srv.request(78, 'item/permissions/requestApproval', { threadId: 't1' });
  srv.request(79, 'account/chatgptAuthTokens/refresh', {});
  await tick();
  assert.deepEqual(seen.map((s) => [s.id, s.ref, s.answerable, s.summary]), [['t1', 'c1:77', true, '$ rm -rf build'], ['t1', 'c1:78', false, 'item/permissions/requestApproval']]);
  assert.deepEqual(srv.responses, [], 'nothing answered automatically');
  assert.equal(a.answerApproval('c1:78', true), false, 'non accept/decline shapes are never answered');
  assert.equal(a.answerApproval('c1:77', false), true);
  assert.deepEqual(srv.responses, [{ jsonrpc: '2.0', id: 77, result: { decision: 'decline' } }]);
  srv.request(80, 'item/fileChange/requestApproval', { threadId: 't1' });
  await tick();
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 80 });
  assert.deepEqual(resolved, ['c1:80']);
  assert.equal(a.answerApproval('c1:80', true), false, 'answered elsewhere first');
});

test('transport close drops every session', async () => {
  const { a, srv } = await started();
  const downs = [];
  a.on('down', (d) => downs.push(d.id));
  srv.transport.close();
  assert.deepEqual(downs, ['t1']);
  assert.equal(a.status('t1'), 'not loaded');
});

test('failed steering never starts or redirects an uncertain input', async () => {
  const { a, srv } = await started({ beforeReply: (m, reply) => {
    if (m.method !== 'turn/steer') return false;
    reply(JSON.stringify({ id: m.id, error: { code: -32600, message: 'turn ended' } }));
    return true;
  } });
  srv.push('turn/started', { threadId: 't1', turn: { id: 'old' } });
  await assert.rejects(a.inject('t1', 'only for old'), /turn ended/);
  assert.equal(srv.calls.some((c) => c.method === 'turn/start'), false);
  await assert.rejects(a.inject('unknown', 'hello'), /not loaded/);
});

test('late old-turn completion does not clear the current steering target', async () => {
  const { a, srv } = await started();
  srv.push('turn/started', { threadId: 't1', turn: { id: 'new' } });
  srv.push('turn/completed', { threadId: 't1', turn: { id: 'old', status: 'completed' } });
  await a.inject('t1', 'current');
  assert.equal(srv.calls.at(-1).method, 'turn/steer');
  assert.equal(srv.calls.at(-1).params.expectedTurnId, 'new');
});

test('disconnect while steering rejects without replaying input after reconnect', async () => {
  let srv;
  const result = await started({ beforeReply: (m) => {
    if (m.method !== 'turn/steer') return false;
    srv.transport.close();
    return true;
  } });
  srv = result.srv;
  srv.push('turn/started', { threadId: 't1', turn: { id: 'old' } });
  await assert.rejects(result.a.inject('t1', 'uncertain'), /connection closed/);
  assert.equal(srv.calls.some((c) => c.method === 'turn/start'), false);
});

test('approval submission stays pending until native resolution and is submitted once', async () => {
  const { a, srv } = await started();
  const seen = [], resolved = [];
  a.on('approval', (x) => seen.push(x));
  a.on('approval-resolved', (x) => resolved.push(x.ref));
  srv.request(90, 'item/fileChange/requestApproval', { threadId: 't1' });
  srv.request(90, 'item/fileChange/requestApproval', { threadId: 't1' });
  assert.equal(seen.length, 1);
  const ref = seen[0].ref;
  assert.equal(a.answerApproval(ref, true), true);
  assert.equal(a.answerApproval(ref, false), false);
  assert.equal(a.approvals.has(ref), true);
  srv.push('serverRequest/resolved', { threadId: 'other', requestId: 90 });
  assert.deepEqual(resolved, []);
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 90 });
  assert.deepEqual(resolved, [ref]);
});

test('status snapshots reflect native running, pending approval, idle and disconnected states', async () => {
  const { a, srv } = await started(); const events = [];
  a.on('status', (e) => events.push(e));
  assert.equal(a.statusSnapshot('t1').state, 'idle');
  assert.equal(a.statusSnapshot('missing').state, 'disconnected');
  srv.push('turn/started', { threadId: 't1', turn: { id: 't' } });
  assert.equal(a.statusSnapshot('t1').state, 'running');
  srv.request(900, 'item/fileChange/requestApproval', { threadId: 't1', command: 'PRIVATE TOOL TEXT' });
  assert.equal(a.statusSnapshot('t1').state, 'waiting-approval');
  assert.equal(a.answerApproval('c1:900', true), true);
  assert.equal(a.statusSnapshot('t1').state, 'waiting-approval', 'submission is not native resolution');
  assert.equal(JSON.stringify(a.statusSnapshot('t1')).includes('PRIVATE'), false);
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 900 });
  assert.equal(a.statusSnapshot('t1').state, 'running');
  srv.push('turn/completed', { threadId: 't1', turn: { id: 't', status: 'completed' } });
  assert.equal(a.statusSnapshot('t1').state, 'idle');
  assert.deepEqual(events, [{ id: 't1' }, { id: 't1' }, { id: 't1' }, { id: 't1' }]);
  srv.transport.close();
  assert.equal(a.statusSnapshot('t1').state, 'disconnected');
});

test('status stays waiting until every native approval for this session is resolved', async () => {
  const { a, srv } = await started();
  srv.request(901, 'item/fileChange/requestApproval', { threadId: 't1' });
  srv.request(902, 'item/permissions/requestApproval', { threadId: 't1' });
  srv.push('serverRequest/resolved', { threadId: 'other', requestId: 901 });
  assert.equal(a.statusSnapshot('t1').state, 'waiting-approval');
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 901 });
  assert.equal(a.statusSnapshot('t1').state, 'waiting-approval');
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 902 });
  assert.equal(a.statusSnapshot('t1').state, 'idle');
});

test('reconnect invalidates old controls despite reused native request ids', async () => {
  const servers = [fakeAppServer(), fakeAppServer()];
  let index = 0;
  const a = new CodexAdapter({ connect: () => servers[index++].transport, probe: async () => ({}) });
  const seen = [], resolved = [];
  a.on('approval', (x) => seen.push(x));
  a.on('approval-resolved', (x) => resolved.push(x.ref));
  await a.start(); await a.refresh();
  servers[0].request(91, 'item/fileChange/requestApproval', { threadId: 't1' });
  const old = seen[0].ref;
  servers[0].transport.close();
  assert.deepEqual(resolved, [old]);
  await a.start(); await a.refresh();
  servers[1].request(91, 'item/fileChange/requestApproval', { threadId: 't1' });
  assert.notEqual(seen[1].ref, old);
  assert.equal(a.answerApproval(old, true), false);
  servers[0].push('serverRequest/resolved', { threadId: 't1', requestId: 91 });
  assert.equal(a.answerApproval(seen[1].ref, true), true);
  servers[1].request(92, 'item/fileChange/requestApproval', { threadId: 'child' });
  assert.equal(seen.length, 2, 'unsubscribed/child requests remain native-only');
});

test('shell commands and execution output never become Telegram progress', () => {
  for (const command of ['powershell -Command secret', "bash -lc 'make'", 'git status']) {
    assert.equal(progressLine({ type: 'commandExecution', command, exitCode: 0, aggregatedOutput: 'private output' }), null);
  }
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

test('isMainSession: top-level threads whose source kind is allowed (default cli only)', () => {
  assert.equal(isMainSession({ source: 'cli' }), true);
  assert.equal(isMainSession({ source: 'cli', forkedFromId: 'x' }), true, 'a user fork counts by its source');
  for (const source of ['vscode', 'appServer', 'exec', 'unknown', { custom: 'ide' }, undefined]) {
    assert.equal(isMainSession({ source }), false, JSON.stringify(source));
  }
  assert.equal(isMainSession({ source: 'cli', parentThreadId: 'p' }), false);
  for (const sub of ['review', 'compact', 'memory_consolidation', { thread_spawn: { depth: 1, parent_thread_id: 'p' } }]) {
    assert.equal(isMainSession({ source: { subAgent: sub } }), false, JSON.stringify(sub));
  }
  const sources = ['vscode', 'custom', 'unknown'];
  assert.equal(isMainSession({ source: 'vscode' }, sources), true);
  assert.equal(isMainSession({ source: { custom: 'ide' } }, sources), true);
  assert.equal(isMainSession({}, sources), true, 'an absent source is unknown');
  assert.equal(isMainSession({ source: 'cli' }, sources), false);
  assert.equal(isMainSession({ source: 'vscode', parentThreadId: 'p' }, sources), false);
});

test('non-main threads never come up, are dismissed, and are not resumed again', async () => {
  const sub = { id: 'sub', cwd: '/w', ephemeral: false, parentThreadId: 't1', source: { subAgent: 'review' }, turns: [] };
  const srv = fakeAppServer({ loaded: ['t1', 'sub'], threads: { sub } });
  const a = new CodexAdapter({ connect: () => srv.transport, probe: async () => ({ status: 'running' }) });
  const ups = [], dismissed = [];
  a.on('up', (s) => ups.push(s.id));
  a.on('dismiss', (d) => dismissed.push(d.id));
  await a.start();
  await a.refresh();
  srv.push('thread/started', { thread: { id: 'spawned', ephemeral: false, source: { subAgent: { thread_spawn: { depth: 1, parent_thread_id: 't1' } } } } });
  srv.push('thread/started', { thread: { id: 'execd', ephemeral: false, source: 'exec' } });
  srv.setLoaded(['t1', 'sub', 'spawned', 'execd']);
  await tick(); await tick();
  await a.refresh();
  assert.deepEqual(ups, ['t1']);
  const resumes = srv.calls.filter((c) => c.method === 'thread/resume').map((c) => c.params.threadId);
  assert.deepEqual(resumes, ['t1', 'sub'], 'sub resumed once to learn it is a subagent; started ones never');
  assert.deepEqual(dismissed.sort(), ['execd', 'spawned', 'sub']);
});

test('user-input requests are relayed as questions, answered once, withdrawn when the TUI answers first', async () => {
  const { a, srv } = await started();
  const seen = [], resolved = [];
  a.on('question', (x) => seen.push(x));
  a.on('question-resolved', (x) => resolved.push(x.ref));
  const questions = [{ id: 'q1', header: 'Pick', question: 'Which?', isOther: false, isSecret: false, options: [{ label: 'A', description: 'a' }] },
    { id: 'q2', header: 'Name', question: 'Name it', isOther: true, isSecret: false, options: null }];
  srv.request(55, 'item/tool/requestUserInput', { threadId: 't1', turnId: 'x', itemId: 'i', isBlocking: true, questions });
  srv.request(56, 'item/tool/requestUserInput', { threadId: 'nope', questions });
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { id: 't1', ref: 'c1:55', answerable: true, questions: [
    { id: 'q1', header: 'Pick', question: 'Which?', isOther: false, isSecret: false, options: [{ label: 'A', description: 'a' }] },
    { id: 'q2', header: 'Name', question: 'Name it', isOther: true, isSecret: false, options: null }] });
  assert.deepEqual(srv.responses, [], 'never answered automatically');
  assert.equal(a.answerQuestion('c1:55', { q1: ['A'], q2: ['x'] }), true);
  assert.equal(a.answerQuestion('c1:55', { q1: ['A'] }), false, 'submitted once');
  assert.deepEqual(srv.responses, [{ jsonrpc: '2.0', id: 55, result: { answers: { q1: { answers: ['A'] }, q2: { answers: ['x'] } } } }]);
  srv.request(57, 'item/tool/requestUserInput', { threadId: 't1', questions: [{ id: 's', question: 'Token?', isSecret: true, options: null }] });
  await tick();
  assert.equal(seen[1].answerable, false, 'a secret is only ever answered locally');
  assert.equal(a.answerQuestion('c1:57', { s: ['x'] }), false);
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 57 });
  assert.deepEqual(resolved, ['c1:57']);
});

test('waitingOnUserInput reads as waiting-input; a pending question does before Codex reports status', async () => {
  const { a, srv } = await started();
  srv.request(60, 'item/tool/requestUserInput', { threadId: 't1', questions: [{ id: 'q', question: '?', options: null, isOther: true }] });
  assert.equal(a.statusSnapshot('t1').state, 'waiting-input');
  srv.push('serverRequest/resolved', { threadId: 't1', requestId: 60 });
  assert.equal(a.statusSnapshot('t1').state, 'idle');
  srv.push('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  assert.equal(a.statusSnapshot('t1').state, 'waiting-input');
});
