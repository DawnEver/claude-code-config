import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { ClaudeAdapter, unwrapChannel, isEnvelope } from './claude-adapter.mjs';

test('claude status follows the turn edges the hooks report', async () => {
  const r = await rig();
  const statuses = [];
  r.a.on('status', (s) => statuses.push(s));
  try {
    assert.equal(r.a.statusSnapshot('s').state, 'disconnected');
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    assert.equal(r.a.statusSnapshot('s').state, 'unknown');
    await r.hook({ sessionId: 's', kind: 'prompt', text: 'work' });
    assert.equal(r.a.statusSnapshot('s').state, 'running');
    await r.rpc(ch, 'reply', { text: 'progress only' });
    assert.equal(r.a.statusSnapshot('s').state, 'running', 'reply is not turn completion');
    await r.rpc(ch, 'permission_request', { request_id: 'p', tool_name: 'Bash' });
    assert.equal(r.a.statusSnapshot('s').state, 'running', 'a pending approval is still a running turn');
    await r.hook({ sessionId: 's', kind: 'final', text: 'done locally' });
    assert.equal(r.a.statusSnapshot('s').state, 'idle');
    assert.equal(r.a.answerApproval('p', true, 's'), true);
    assert.equal(r.a.statusSnapshot('s').state, 'idle');
    await r.a.inject('s', 'new task', 'user');
    assert.equal(r.a.statusSnapshot('s').state, 'running');
    ch.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(r.a.statusSnapshot('s').state, 'disconnected');
    assert.equal(statuses.at(-1).id, 's');
    assert.equal(statuses.at(-1).state, 'disconnected');
  } finally { await r.a.close(); }
});

test('approval answers require a pending request in the exact connected session', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    assert.equal(r.a.answerApproval('unknown', true, 's'), false);
    assert.ok((await r.rpc(ch, 'permission_request', { request_id: '', tool_name: 'Bash' })).error);
    await r.rpc(ch, 'permission_request', { request_id: 'p', tool_name: 'Bash' });
    assert.ok((await r.rpc(ch, 'permission_request', { request_id: 'p', tool_name: 'Bash' })).error);
    assert.equal(r.a.answerApproval('p', true, 'other'), false);
    assert.equal(r.a.answerApproval('p', true, 's'), true);
    assert.equal(r.a.answerApproval('p', false, 's'), false);
    // A reconnect with the same session id cannot inherit the previous channel's requests.
    const replacement = await r.open();
    await r.rpc(replacement, 'register', { sessionId: 's' });
    assert.equal(r.a.answerApproval('p', true, 's'), false);
    await r.rpc(replacement, 'permission_request', { request_id: 'next', tool_name: 'Write' });
    replacement.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(r.a.answerApproval('next', true, 's'), false);
  } finally { await r.a.close(); }
});

test('replacement and disconnect withdraw old approval correlations before native ref reuse', async () => {
  const r = await rig();
  const resolved = [];
  r.a.on('approval-resolved', (event) => resolved.push(event));
  try {
    const first = await r.open();
    await r.rpc(first, 'register', { sessionId: 's' });
    await r.rpc(first, 'permission_request', { request_id: 'reused', tool_name: 'Bash' });
    const replacement = await r.open();
    await r.rpc(replacement, 'register', { sessionId: 's' });
    assert.deepEqual(resolved, [{ id: 's', ref: 'reused', reason: 'correlation-withdrawn' }]);
    await r.rpc(replacement, 'permission_request', { request_id: 'reused', tool_name: 'Write' });
    assert.equal(resolved.length, 1, 'old socket close cannot withdraw the new correlation');
    replacement.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(resolved, [
      { id: 's', ref: 'reused', reason: 'correlation-withdrawn' },
      { id: 's', ref: 'reused', reason: 'correlation-withdrawn' },
    ]);
    assert.equal(r.a.answerApproval('reused', true, 's'), false);
  } finally { await r.a.close(); }
});

/** Drive the adapter over real TCP like the channel and the hook do. */
async function rig() {
  const a = new ClaudeAdapter();
  const port = await a.listen(0);
  const events = [];
  for (const k of ['up', 'prompt', 'final', 'notice', 'down']) a.on(k, (e) => events.push([k, e]));
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

test('after /clear or /resume the id is new: the claude process routes it, and the session learns the id', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'boot', cwd: '/repo', claudePid: 77 });
    // The hook's first call names only ids and misses; its retry names its own claude process.
    await r.hook({ sessionId: 'cleared', kind: 'prompt', text: 'after clear' });
    await r.hook({ sessionId: 'cleared', claudePid: 77, retry: true, kind: 'prompt', text: 'after clear' });
    // A nested claude's retry names ITS process, so it never lands in the parent's Topic.
    await r.hook({ sessionId: 'nested', kind: 'prompt', text: 'nested' });
    await r.hook({ sessionId: 'nested', claudePid: 78, retry: true, kind: 'prompt', text: 'nested' });
    assert.deepEqual(r.events.filter(([k]) => k === 'prompt').map(([, e]) => [e.id, e.text]), [['boot', 'after clear']]);
    assert.deepEqual(r.a.held.map((h) => h.m.text), ['nested'], 'the routed retry dropped its held first copy');
    // Learned: later calls name only the id — activity is never retried, nor is a question.
    await r.hook({ sessionId: 'cleared', kind: 'activity', state: 'waiting-approval' });
    assert.equal(r.a.statusSnapshot('boot').state, 'waiting-approval');
    const asked = [];
    r.a.on('question', (e) => asked.push(e.id));
    const q = await r.open();
    await r.rpc(q, 'question', { sessionId: 'cleared', questions: [{ question: 'Q?', options: [{ label: 'A' }] }] });
    assert.deepEqual(asked, ['boot'], 'a question routes by the learned id');
    q.destroy();
    // The conversation later resumed in another process belongs to that process alone.
    const other = await r.open();
    await r.rpc(other, 'register', { sessionId: 'cleared', cwd: '/repo', claudePid: 79 });
    await r.hook({ sessionId: 'cleared', kind: 'prompt', text: 'resumed elsewhere' });
    assert.deepEqual(r.events.filter(([k]) => k === 'prompt').at(-1)[1], { id: 'cleared', text: 'resumed elsewhere' });
    other.destroy();
    ch.destroy();
    await new Promise((res) => setTimeout(res, 50));
  } finally { await r.a.close(); }
});

test('a failed final carries its status to the daemon', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'u', cwd: '/repo' });
    await r.hook({ sessionId: 'u', kind: 'prompt', text: 'go' });
    await r.hook({ sessionId: 'u', kind: 'final', status: 'failed', text: 'rate_limit: slow down' });
    assert.deepEqual(r.events.filter(([k]) => k === 'final').map(([, e]) => [e.text, e.status]), [['rate_limit: slow down', 'failed']]);
    ch.destroy();
    await new Promise((res) => setTimeout(res, 50));
  } finally { await r.a.close(); }
});

test('mirror calls route by session id, are held before register, never cross sessions, and dedupe against reply', async () => {
  const r = await rig();
  try {
    await r.hook({ sessionId: 'uuid-1', kind: 'prompt', text: 'early' });
    assert.deepEqual(r.events, [], 'held until the channel registers');
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'uuid-1', cwd: '/repo' });
    // A nested session (e.g. `claude -p` run from inside another session) is its own session.
    const parent = await r.open();
    await r.rpc(parent, 'register', { sessionId: 'parent', cwd: '/repo' });
    await r.hook({ sessionId: 'uuid-1', kind: 'prompt', text: '<channel source="session-bridge" user="u">from phone</channel>' });
    await r.rpc(ch, 'reply', { text: 'done' });
    await r.hook({ sessionId: 'uuid-1', kind: 'final', text: 'done\n' });
    await r.hook({ sessionId: 'uuid-1', kind: 'final', text: '  ' });
    await r.hook({ sessionId: 'parent', kind: 'prompt', text: 'parent question' });
    await r.hook({ sessionId: 'parent', kind: 'final', text: 'parent answer' });
    await r.hook({ sessionId: 'uuid-1', kind: 'prompt', text: 'q2' });
    await r.hook({ sessionId: 'uuid-1', kind: 'final', text: 'second turn' });
    await r.hook({ sessionId: 'stranger', kind: 'final', text: 'nobody' });
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

test('a turn in flight across a bridge restart still mirrors its answer', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', cwd: '/repo' });
    await r.hook({ sessionId: 's', kind: 'final', text: 'answer of a turn begun before the restart' });
    assert.deepEqual(r.events.filter(([k]) => k === 'final').map(([, e]) => e.text), ['answer of a turn begun before the restart']);
  } finally { await r.a.close(); }
});

test('every turn end mirrors its unsent text; envelope prompts stay hidden', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', cwd: '/repo' });
    const ids = 's';
    await r.hook({ sessionId: ids, kind: 'prompt', text: 'human question' });
    await r.hook({ sessionId: ids, kind: 'final', text: 'human answer' });
    await r.hook({ sessionId: ids, kind: 'final', text: 'stop-hook continuation' });
    await r.hook({ sessionId: ids, kind: 'prompt', text: '<task-notification>done</task-notification>' });
    await r.hook({ sessionId: ids, kind: 'final', text: 'reaction to the background task' });
    await r.a.inject('s', 'from phone', 'u');
    await r.hook({ sessionId: ids, kind: 'final', text: 'phone answer' });
    assert.deepEqual(r.events.filter(([k]) => k !== 'up').map(([k, e]) => [k, e.text]), [
      ['prompt', 'human question'], ['final', 'human answer'], ['final', 'stop-hook continuation'],
      ['final', 'reaction to the background task'], ['final', 'phone answer'],
    ]);
    ch.destroy();
  } finally { await r.a.close(); }
});

test('a final carries all text blocks of the turn; blocks already sent are not repeated', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', cwd: '/repo' });
    const ids = 's';
    await r.hook({ sessionId: ids, kind: 'prompt', text: 'go' });
    await r.rpc(ch, 'reply', { text: 'heads-up' });
    await r.hook({ sessionId: ids, kind: 'final', texts: ['heads-up', 'analysis', 'answer'] });
    await r.hook({ sessionId: ids, kind: 'final', texts: ['heads-up', 'analysis', 'answer', 'after review'] });
    await r.hook({ sessionId: ids, kind: 'final', texts: ['answer'] });
    await r.hook({ sessionId: ids, kind: 'prompt', text: 'again' });
    await r.hook({ sessionId: ids, kind: 'final', texts: ['answer'] });
    assert.deepEqual(r.events.filter(([k]) => k === 'final').map(([, e]) => e.text),
      ['heads-up', 'analysis\n\nanswer', 'after review', 'answer']);
  } finally { await r.a.close(); }
});

test('notices are mirrored; a local answer only for a question posted without controls', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', cwd: '/repo' });
    const ids = 's';
    await r.hook({ sessionId: ids, kind: 'activity', state: 'waiting-approval', text: 'Claude needs your permission to use Bash' });
    await r.hook({ sessionId: ids, kind: 'answer', text: 'Q? -> A' });
    { const q = await r.open(); await r.rpc(q, 'question', { sessionId: ids, questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }); q.destroy(); }
    await r.hook({ sessionId: ids, kind: 'answer', text: 'Q? -> A' });
    await r.hook({ sessionId: ids, kind: 'answer', text: 'Q? -> A' });
    await r.rpc(ch, 'permission_request', { request_id: 'p', tool_name: 'Bash' });
    await r.hook({ sessionId: ids, kind: 'activity', state: 'waiting-approval', text: 'Claude needs your permission to use Bash' });
    assert.deepEqual(r.events.filter(([k]) => k === 'notice').map(([, e]) => [e.text, e.alert ?? false]),
      [['Claude needs your permission to use Bash', true], ['answered locally: Q? -> A', false]]);
  } finally { await r.a.close(); }
});

test('inject and status report a disconnected channel; there is no interrupt', async () => {
  const a = new ClaudeAdapter();
  await assert.rejects(a.inject('nope', 'x'), /channel disconnected/);
  assert.equal(a.status('nope'), 'channel disconnected');
  assert.equal(a.interrupt, undefined);
});

test('hook activity drives the state machine; only the channel closing takes the session down', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    const state = () => r.a.statusSnapshot('s').state;
    await r.hook({ sessionId: 's', kind: 'prompt', text: 'go' });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'waiting-approval' });
    assert.equal(state(), 'waiting-approval');
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running' });
    assert.equal(state(), 'running');
    await r.hook({ sessionId: 's', kind: 'activity', state: 'waiting-input' });
    assert.equal(state(), 'waiting-input');
    await r.hook({ sessionId: 's', kind: 'activity', state: 'idle' });
    assert.equal(state(), 'idle');
    assert.ok((await r.hook({ sessionId: 's', kind: 'activity', state: 'bogus' })).error);
    assert.deepEqual(await r.hook({ sessionId: 'ghost', kind: 'activity', state: 'running' }), { jsonrpc: '2.0', id: 1, result: { ok: true, routed: false } });
    assert.deepEqual(r.a.held, [], 'activity is never held: the next hook carries fresher state');
    assert.ok((await r.hook({ sessionId: 's', kind: 'end' })).error, 'SessionEnd also fires on /clear and /resume: not an end signal');
    assert.equal(state(), 'idle');
    ch.destroy();
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(state(), 'disconnected');
    assert.deepEqual(r.events.filter(([k]) => k === 'down').map(([, e]) => e.id), ['s']);
  } finally { await r.a.close(); }
});

const ASK = [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }];
const ask = async (r, params) => { const s = await r.open(); const res = r.rpc(s, 'question', params); return { s, res }; };

test('a question in a Telegram-started turn waits for the Telegram answer', async () => {
  const r = await rig();
  const questions = [];
  r.a.on('question', (e) => questions.push(e));
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    await r.a.inject('s', 'from phone', 'u');
    await r.hook({ sessionId: 's', kind: 'prompt', text: '<channel source="session-bridge" user="u">from phone</channel>' });
    const { s, res } = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    await new Promise((res2) => setTimeout(res2, 30));
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0].questions, [{ id: '0', header: 'Colour', question: 'Which colour?', isOther: true, isSecret: false, multiSelect: false,
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }]);
    assert.equal(questions[0].answerable, true);
    assert.equal(r.a.statusSnapshot('s').state, 'waiting-input');
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Blue'] }, 'other'), false, 'wrong session');
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Blue'] }, 's'), true);
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Red'] }, 's'), false, 'answered once');
    assert.deepEqual((await res).result, { answers: { 'Which colour?': 'Blue' } });
    s.destroy();
  } finally { await r.a.close(); }
});

test('a question in a locally typed turn is information only and never waits', async () => {
  const r = await rig();
  const questions = [];
  r.a.on('question', (e) => questions.push(e));
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    await r.a.inject('s', 'from phone', 'u');
    await r.hook({ sessionId: 's', kind: 'prompt', text: 'typed here' });
    const { s, res } = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    assert.deepEqual((await res).result, { answers: null });
    assert.equal(questions[0].answerable, false);
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Red'] }, 's'), false);
    s.destroy();
    const unrouted = await ask(r, { sessionId: 'ghost', questions: ASK, wait: true });
    assert.deepEqual((await unrouted.res).result, { answers: null });
    unrouted.s.destroy();
  } finally { await r.a.close(); }
});

test('a waiting question is withdrawn when its hook gives up, and released when undeliverable', async () => {
  const r = await rig();
  const questions = [], resolved = [];
  r.a.on('question', (e) => questions.push(e));
  r.a.on('question-resolved', (e) => resolved.push(e));
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    await r.a.inject('s', 'from phone', 'u');
    const first = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    await new Promise((res) => setTimeout(res, 30));
    first.s.destroy();
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(resolved, [{ id: 's', ref: questions[0].ref }]);
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Red'] }, 's'), false);
    const second = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    await new Promise((res) => setTimeout(res, 30));
    r.a.releaseQuestion(questions[1].ref, 's');
    assert.deepEqual((await second.res).result, { answers: null });
    second.s.destroy();
  } finally { await r.a.close(); }
});

test('a session without inbound queues Telegram messages and hands them to the next Stop hook', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', inbound: false, thirdParty: true });
    const ids = 's';
    assert.deepEqual(await r.a.inject('s', 'idle msg', 'u'), { queued: true,
      note: 'queued: this session runs a third-party provider, which Claude Code gives no channel, so the message waits for its next turn to end (type something locally to wake it). Use ccc or cods to message it directly.' });
    await r.hook({ sessionId: ids, kind: 'prompt', text: 'local work' });
    assert.match((await r.a.inject('s', 'second', 'v')).note, /^queued: .*delivered when the current turn ends/);
    const replayed = await r.hook({ sessionId: ids, kind: 'final', text: 'spooled earlier answer', replay: true });
    assert.equal(replayed.result.deliver, undefined, 'a spool replay cannot continue the session');
    const res = await r.hook({ sessionId: ids, kind: 'final', text: 'local answer' });
    assert.deepEqual(res.result.deliver, [{ text: 'idle msg', user: 'u' }, { text: 'second', user: 'v' }]);
    assert.equal(r.a.statusSnapshot('s').state, 'running');
    assert.equal((await r.hook({ sessionId: ids, kind: 'final', text: 'phone answer' })).result.deliver, undefined, 'delivered once');
    assert.deepEqual(r.events.filter(([k]) => k === 'final').map(([, e]) => e.text), ['spooled earlier answer', 'local answer', 'phone answer'], 'the continuation is a Telegram turn');
    ch.destroy();
  } finally { await r.a.close(); }
});

test('a session missing only the flag says to resume with ccc', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', inbound: false });
    assert.match((await r.a.inject('s', 'x', 'u')).note, /not started with ccc[\s\S]*ccc --resume/);
    ch.destroy();
  } finally { await r.a.close(); }
});

test('a held hook call that never finds its channel is dropped with a warning, not silently', async () => {
  const r = await rig();
  let t = 0;
  r.a.now = () => t;
  const warns = [];
  r.a.on('warn', (m) => warns.push(m));
  try {
    await r.hook({ sessionId: 'orphan', kind: 'prompt', text: 'lost' });
    t = 31000;
    await r.hook({ sessionId: 'orphan', kind: 'final', text: 'later' });
    assert.equal(warns.length, 1);
    assert.match(warns[0], /dropped unroutable prompt for orphan/);
  } finally { await r.a.close(); }
});
