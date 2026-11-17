import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeAdapter, unwrapChannel, isEnvelope, continuedIn } from './claude-adapter.mjs';
import { lineSplitter } from './jsonrpc.mjs';

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
};

test('continuedIn: the last continued-in record of the tail; none, cut or missing reads null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-continued-'));
  try {
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, `${'x'.repeat(70000)}\n{"type":"continued-in","sessionId":"a","continuedInSessionId":"b"}\n{"type":"queue-operation"}\n`);
    assert.equal(continuedIn(f), 'b');
    fs.writeFileSync(f, '{"type":"user","uuid":"u"}\n{"type":"continued-in","sess');
    assert.equal(continuedIn(f), null);
    assert.equal(continuedIn(path.join(dir, 'missing.jsonl')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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
    const T = Date.now();
    // Tasks: a shell and a background agent start; the shell ends; the agent runs past the turn.
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', at: T + 100, task: { op: 'start', id: 'u1', kind: 'shell', label: 'npm test', background: false } });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', at: T + 200, task: { op: 'start', id: 'u2', kind: 'agent', label: 'Explore: x', background: true } });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', at: T + 300, task: { op: 'end', id: 'u1', status: 'failed' } });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', task: { op: 'start', id: 'u3', kind: 'rm -rf', label: 'x' } });
    await r.hook({ sessionId: 's', kind: 'final', texts: [], background: [{ id: 'u2', kind: 'agent', label: 'Explore: x', startedAt: T + 200 }, { id: 'bad', kind: 'daemon', startedAt: 1 }], at: T + 400 });
    const snap = r.a.statusSnapshot('s');
    assert.equal(snap.state, 'idle');
    assert.deepEqual(snap.tasks.map((t) => [t.id, t.kind, t.startedAt]), [['u2', 'agent', T + 200]],
      'idle with the background agent still running; the ended shell is gone; a malformed task is dropped at the boundary');
    await r.hook({ sessionId: 's', kind: 'final', text: 'all done', background: [], at: T + 500 });
    assert.equal(r.a.statusSnapshot('s').tasks, undefined, 'a turn end with no background task open ends the agent: nothing runs');
    await r.a.inject('s', 'new task', 'user');
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
async function rig(opts = {}) {
  const a = new ClaudeAdapter(opts);
  const port = await a.listen(0);
  const events = [];
  for (const k of ['up', 'prompt', 'final', 'notice', 'down']) a.on(k, (e) => events.push([k, e]));
  const rpc = (sock, method, params) => new Promise((resolve) => {
    let buf = '';
    // The response may share a chunk with a notification (an inbound delivered on register).
    const onData = (d) => {
      buf += d;
      const reply = buf.split('\n').slice(0, -1).map((l) => JSON.parse(l)).find((m) => m.id !== undefined);
      if (reply) { sock.off('data', onData); resolve(reply); }
    };
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

test('after /clear or /resume the id is new: the claude process the hook names routes it, and the session learns the id', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'boot', cwd: '/repo', claudePid: 77 });
    // Every hook names its claude process (CLAUDE_PID): the new id routes on its first call.
    const routed = await r.hook({ sessionId: 'cleared', claudePid: 77, kind: 'prompt', text: 'after clear' });
    assert.deepEqual(routed.result, { ok: true, routed: true });
    // A process no channel registered under routes nothing: answered, never held here.
    const stray = await r.hook({ sessionId: 'nested', claudePid: 78, kind: 'prompt', text: 'nested' });
    assert.deepEqual(stray.result, { ok: true, routed: false }, 'PLANTED CONTROL: an unknown process routes nothing');
    assert.deepEqual(r.events.filter(([k]) => k === 'prompt').map(([, e]) => [e.id, e.text]), [['boot', 'after clear']]);
    // Learned: later calls route by the id alone (a question too).
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
    await r.hook({ sessionId: 'cleared', claudePid: 79, kind: 'prompt', text: 'resumed elsewhere' });
    assert.deepEqual(r.events.filter(([k]) => k === 'prompt').at(-1)[1], { id: 'cleared', text: 'resumed elsewhere' });
    other.destroy();
    ch.destroy();
    await new Promise((res) => setTimeout(res, 50));
  } finally { await r.a.close(); }
});

test('nothing is held or dropped here: an unroutable call is answered routed:false, again and again, never with a drop', async () => {
  let clock = 0;
  const r = await rig({ now: () => clock });
  const warned = [];
  r.a.on('warn', (w) => warned.push(w));
  try {
    for (const t of [0, 31_000, 120_000]) {
      clock = t;
      assert.deepEqual((await r.hook({ sessionId: 'early', claudePid: 90, kind: 'prompt', text: 'before its channel' })).result, { ok: true, routed: false });
    }
    assert.deepEqual(warned, [], 'no timed drop, no "dropped unroutable" warning');
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'early', cwd: '/repo', claudePid: 90 });
    assert.deepEqual((await r.hook({ sessionId: 'early', claudePid: 90, kind: 'prompt', text: 'before its channel' })).result, { ok: true, routed: true },
      'PLANTED CONTROL: once its channel is up the same call routes -- the hook spool re-sends it until then');
    ch.destroy();
    await new Promise((res) => setTimeout(res, 50));
  } finally { await r.a.close(); }
});

test('a nested session registers as nested: its calls are answered `nested` (not mirrored) while it lives, never a Topic', async () => {
  const r = await rig();
  try {
    const nested = await r.open();
    assert.deepEqual((await r.rpc(nested, 'register', { sessionId: 'n-1', cwd: '/repo', claudePid: 55, nested: true })).result, { ok: true, nested: true });
    assert.deepEqual((await r.hook({ sessionId: 'n-1', claudePid: 55, kind: 'final', text: 'inner' })).result, { ok: true, routed: false, nested: true });
    assert.deepEqual(r.events, [], 'no up, no final: a nested session is not bridged');
    nested.destroy();
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual((await r.hook({ sessionId: 'n-1', claudePid: 55, kind: 'final', text: 'inner' })).result, { ok: true, routed: false },
      'PLANTED CONTROL: once its process is gone it is no longer known as nested');
  } finally { await r.a.close(); }
});

test('a resumed session with a new id receives an inbound message, and so does an agent-view (no-channel) session, across a daemon restart', async () => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-queue-'));
  try {
    // A resumed session (`claude --resume`/`--fork-session`, a new id) with the channel flag: inbound goes straight in.
    let r = await rig({ queueDir });
    const resumed = await r.open();
    const inbox = [];
    resumed.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { const m = JSON.parse(l); if (m.method === 'inbound') inbox.push(m.params.text); } });
    await r.rpc(resumed, 'register', { sessionId: 'forked-new-id', cwd: '/repo', claudePid: 61 });
    await r.a.inject('forked-new-id', 'hello resumed', 'u');
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(inbox, ['hello resumed']);
    // An agent-view session: the channel flag is dropped, so inbound waits for its Stop -- on disk.
    const bg = await r.open();
    await r.rpc(bg, 'register', { sessionId: 'bg-1', cwd: '/repo', claudePid: 62, inbound: false });
    assert.equal((await r.a.inject('bg-1', 'hello background', 'u')).queued, true);
    resumed.destroy(); bg.destroy();
    await r.a.close();
    // The daemon restarts (a handover): the queued message survives it.
    r = await rig({ queueDir });
    const bg2 = await r.open();
    await r.rpc(bg2, 'register', { sessionId: 'bg-1', cwd: '/repo', claudePid: 62, inbound: false });
    const stop = await r.hook({ sessionId: 'bg-1', claudePid: 62, kind: 'final', text: 'turn done' });
    assert.deepEqual(stop.result.deliver?.map((d) => d.text), ['hello background'], 'the next Stop gets it');
    assert.deepEqual(fs.readdirSync(queueDir), [], 'and the queue is empty once handed over');
    // PLANTED CONTROL: without a queue dir, the same restart forgets it.
    const bare = await rig();
    const b1 = await bare.open();
    await bare.rpc(b1, 'register', { sessionId: 'bg-2', cwd: '/repo', claudePid: 63, inbound: false });
    await bare.a.inject('bg-2', 'lost without a queue dir', 'u');
    b1.destroy(); await bare.a.close();
    const bare2 = await rig();
    const b2 = await bare2.open();
    await bare2.rpc(b2, 'register', { sessionId: 'bg-2', cwd: '/repo', claudePid: 63, inbound: false });
    assert.equal((await bare2.hook({ sessionId: 'bg-2', claudePid: 63, kind: 'final', text: 'x' })).result.deliver, undefined);
    b2.destroy(); await bare2.a.close();
    bg2.destroy();
    await r.a.close();
  } finally { fs.rmSync(queueDir, { recursive: true, force: true }); }
});

test('a message for a session that is not running waits on disk and is delivered when it is resumed', async () => {
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-queue-'));
  const r = await rig({ queueDir });
  try {
    const note = await r.a.inject('closed-1', 'while you were away', 'u');
    assert.equal(note.queued, true);
    assert.match(note.note, /delivered when it is resumed/);
    const ch = await r.open();
    const inbox = [];
    ch.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { const m = JSON.parse(l); if (m.method === 'inbound') inbox.push(m.params.text); } });
    await r.rpc(ch, 'register', { sessionId: 'closed-1', cwd: '/repo', claudePid: 64 });
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(inbox, ['while you were away'], 'a channel that takes inbound gets it on register');
    ch.destroy();
    await new Promise((res) => setTimeout(res, 50));
  } finally { await r.a.close(); fs.rmSync(queueDir, { recursive: true, force: true }); }
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

test('mirror calls route by session id, wait (in the hook spool) for their channel, never cross sessions, and dedupe against reply', async () => {
  const r = await rig();
  try {
    assert.deepEqual((await r.hook({ sessionId: 'uuid-1', kind: 'prompt', text: 'early' })).result, { ok: true, routed: false });
    assert.deepEqual(r.events, [], 'nothing routed before the channel registers');
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 'uuid-1', cwd: '/repo' });
    await r.hook({ sessionId: 'uuid-1', kind: 'prompt', text: 'early' });   // the spool's re-send
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

test('an async hook stamped earlier never overwrites a later state', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    const state = () => r.a.statusSnapshot('s').state;
    await r.hook({ sessionId: 's', kind: 'activity', state: 'waiting-approval', at: 200 });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', at: 100 });
    assert.equal(state(), 'waiting-approval', 'a PreToolUse landing after its permission prompt');
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', at: 300 });
    assert.equal(state(), 'running');
    await r.hook({ sessionId: 's', kind: 'final', texts: ['done'], at: 400 });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running', at: 350 });
    assert.equal(state(), 'idle', 'a late PostToolUse does not reopen a finished turn');
  } finally { await r.a.close(); }
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

// A question never holds its hook (every hook < 5 s, user ruling D24): in a Telegram-started
// turn it is posted there at once and the hook denies the terminal dialog; the tapped answer
// reaches the session as its next message.
test('a question in a Telegram-started turn is posted there at once; its answer arrives as the next message', async () => {
  const r = await rig();
  const questions = [], inbound = [];
  r.a.on('question', (e) => questions.push(e));
  try {
    const ch = await r.open();
    ch.on('data', lineSplitter((l) => { const m = JSON.parse(l); if (m.method === 'inbound') inbound.push(m.params); }));
    await r.rpc(ch, 'register', { sessionId: 's' });
    await r.a.inject('s', 'from phone', 'u');
    await r.hook({ sessionId: 's', kind: 'prompt', text: '<channel source="session-bridge" user="u">from phone</channel>' });
    const t0 = Date.now();
    const { s, res } = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    assert.deepEqual((await res).result, { posted: true }, 'answered at once, never held open');
    assert.ok(Date.now() - t0 < 1000);
    s.destroy();
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0].questions, [{ id: '0', header: 'Colour', question: 'Which colour?', isOther: true, isSecret: false, multiSelect: false,
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }]);
    assert.equal(questions[0].answerable, true);
    await new Promise((res2) => setTimeout(res2, 30));
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Blue'] }, 's'), true, 'the hook closing its socket does not withdraw a posted question');
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Blue'] }, 'other'), false, 'wrong session');
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Red'] }, 's'), false, 'answered once');
    await until(() => inbound.some((m) => /Which colour\? -> Blue/.test(m.text)));
    assert.equal(r.a.statusSnapshot('s').state, 'running', 'the answer starts the next turn');
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

test('a posted question that cannot be shown on Telegram tells the session to ask it in the terminal; its end withdraws it', async () => {
  const r = await rig();
  const questions = [], resolved = [], inbound = [];
  r.a.on('question', (e) => questions.push(e));
  r.a.on('question-resolved', (e) => resolved.push(e));
  try {
    const ch = await r.open();
    ch.on('data', lineSplitter((l) => { const m = JSON.parse(l); if (m.method === 'inbound') inbound.push(m.params); }));
    await r.rpc(ch, 'register', { sessionId: 's' });
    await r.a.inject('s', 'from phone', 'u');
    const first = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    assert.deepEqual((await first.res).result, { posted: true });
    first.s.destroy();
    assert.equal(r.a.releaseQuestion(questions[0].ref, 's'), true);
    await until(() => inbound.some((m) => /could not be shown on Telegram/.test(m.text)));
    assert.equal(r.a.answerQuestion(questions[0].ref, { 0: ['Red'] }, 's'), false, 'released: no longer answerable');
    const second = await ask(r, { sessionId: 's', questions: ASK, wait: true });
    await second.res;
    second.s.destroy();
    ch.destroy();
    await until(() => resolved.some((e) => e.ref === questions[1].ref));
    assert.equal(r.a.answerQuestion(questions[1].ref, { 0: ['Red'] }, 's'), false, 'the session ended: its question is withdrawn');
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
    assert.deepEqual(res.result.deliver, [{ text: 'idle msg', user: 'u', userId: '' }, { text: 'second', user: 'v', userId: '' }]);
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

// Agent-view handoff: Claude Code appends `continued-in` to the OLD transcript only.
const handoff = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-handoff-'));
  const r = await rig();
  const moves = [];
  r.a.on('superseded', (e) => moves.push(e));
  const transcript = (id, lines = []) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, [JSON.stringify({ type: 'user', uuid: 'u0', sessionId: id, message: { content: 'shared history' } }), ...lines].join('\n') + '\n');
    return f;
  };
  const continued = (f, from, to) => fs.appendFileSync(f, JSON.stringify({ type: 'continued-in', sessionId: from, continuedInSessionId: to }) + '\n');
  const inbox = (sock) => {
    const got = [];
    sock.on('data', lineSplitter((l) => { const m = JSON.parse(l); if (m.method === 'inbound') got.push(m.params.text); }));
    return got;
  };
  try { await fn({ r, moves, transcript, continued, inbox }); } finally { await r.a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
};

test('handoff: a fork shares history but writes no continued-in, so it keeps its own session', () => handoff(async ({ r, moves, transcript, inbox }) => {
  const orig = await r.open();
  const got = inbox(orig);
  await r.rpc(orig, 'register', { sessionId: 'y', transcriptPath: transcript('y') });
  const fork = await r.open();
  await r.rpc(fork, 'register', { sessionId: 'f', transcriptPath: transcript('f') });
  await r.hook({ sessionId: 'f', kind: 'prompt', text: 'fork work', transcriptPath: transcript('f') });
  await r.a.inject('y', 'to original', 'u');
  await until(() => got.length);
  assert.deepEqual(got, ['to original']);
  assert.deepEqual(moves, []);
  orig.destroy(); fork.destroy();
}));

test('handoff: the relaunch registering moves the session; the stale channel gets no inbound and cannot re-register', () => handoff(async ({ r, moves, transcript, continued, inbox }) => {
  const ty = transcript('y');
  const old = await r.open();
  const stale = inbox(old);
  await r.rpc(old, 'register', { sessionId: 'y', transcriptPath: ty });
  continued(ty, 'y', 'x');
  const fresh = await r.open();
  await r.rpc(fresh, 'register', { sessionId: 'x', inbound: false, transcriptPath: transcript('x') });
  assert.deepEqual(moves, [{ id: 'x', from: 'y' }]);
  await assert.rejects(r.a.inject('y', 'hi', 'u'), /disconnected/);
  assert.match((await r.a.inject('x', 'hi', 'u')).note, /agent view[\s\S]*ccc --resume x/);
  const again = await r.open();
  assert.deepEqual((await r.rpc(again, 'register', { sessionId: 'y', transcriptPath: ty })).result, { ok: true, continuedIn: 'x' });
  assert.equal(r.a.statusSnapshot('y').state, 'disconnected');
  assert.deepEqual(stale, []);
  assert.deepEqual(moves, [{ id: 'x', from: 'y' }]);
  old.destroy(); fresh.destroy(); again.destroy();
}));

test('handoff: an inject before the relaunch\'s first hook is redirected to it', () => handoff(async ({ r, moves, transcript, continued, inbox }) => {
  const ty = transcript('y');
  const old = await r.open();
  const stale = inbox(old);
  await r.rpc(old, 'register', { sessionId: 'y', transcriptPath: ty });
  // The relaunch's channel connects before the record is written, so register cannot see it.
  const fresh = await r.open();
  const got = inbox(fresh);
  await r.rpc(fresh, 'register', { sessionId: 'x' });
  continued(ty, 'y', 'x');
  assert.equal(await r.a.inject('y', 'hi', 'u'), undefined);
  await until(() => got.length);
  assert.deepEqual(got, ['hi']);
  assert.deepEqual(stale, []);
  assert.deepEqual(moves, [{ id: 'x', from: 'y' }]);
  old.destroy(); fresh.destroy();
}));

test('handoff: an inject before the relaunch connects is held for it, then delivered', () => handoff(async ({ r, moves, transcript, continued, inbox }) => {
  const ty = transcript('y');
  const old = await r.open();
  const stale = inbox(old);
  await r.rpc(old, 'register', { sessionId: 'y', transcriptPath: ty });
  continued(ty, 'y', 'z');
  assert.match((await r.a.inject('y', 'early', 'u')).note, /continued in session z[\s\S]*delivered when it does/);
  assert.deepEqual(moves, []);
  const fresh = await r.open();
  const got = inbox(fresh);
  await r.rpc(fresh, 'register', { sessionId: 'z' });
  assert.deepEqual(moves, [{ id: 'z', from: 'y' }]);
  await until(() => got.length);
  assert.deepEqual(got, ['early']);
  assert.deepEqual(stale, []);
  old.destroy(); fresh.destroy();
}));

test('handoff: the relaunch\'s first hook naming its transcript also moves the session', () => handoff(async ({ r, moves, transcript, continued }) => {
  const ty = transcript('y');
  const old = await r.open();
  await r.rpc(old, 'register', { sessionId: 'y' });
  await r.hook({ sessionId: 'y', kind: 'prompt', text: 'before', transcriptPath: ty });
  const fresh = await r.open();
  await r.rpc(fresh, 'register', { sessionId: 'x' });
  continued(ty, 'y', 'x');
  assert.deepEqual(moves, []);
  await r.hook({ sessionId: 'x', kind: 'activity', state: 'running', transcriptPath: transcript('x') });
  assert.deepEqual(moves, [{ id: 'x', from: 'y' }]);
  old.destroy(); fresh.destroy();
}));

test('transcriptName: /rename beats the generated title, read on incrementally', async () => {
  const { transcriptName } = await import('./claude-adapter.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tname-'));
  const file = path.join(dir, 't.jsonl');
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, line({ type: 'user' }) + line({ type: 'ai-title', aiTitle: 'Generated' }));
  let s = transcriptName(file);
  assert.equal(s.name, 'Generated');
  fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'Mine' }) + line({ type: 'ai-title', aiTitle: 'Later' }) + '{"type":"custom-title","custom');
  s = transcriptName(file, s);
  assert.equal(s.name, 'Mine');
  assert.equal(s.at, fs.statSync(file).size - '{"type":"custom-title","custom'.length, 'a cut line is read next time');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tasks: an interrupted turn (no Stop) ends its foreground calls at the next prompt or idle; a resumed session never revives its old process\'s tasks', async () => {
  const r = await rig();
  try {
    const T = Date.now();
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's', startedAt: T });
    const start = (id, at, background = false) => r.hook({ sessionId: 's', kind: 'activity', state: 'running', at, task: { op: 'start', id, kind: 'shell', label: id, background } });
    await start('f1', T + 100);
    await r.hook({ sessionId: 's', kind: 'prompt', text: 'next', at: T + 200 });
    assert.equal(r.a.statusSnapshot('s').tasks, undefined, 'a new prompt: the interrupted turn\'s foreground call has returned');
    await start('f2', T + 300);
    await r.hook({ sessionId: 's', kind: 'activity', state: 'idle', at: T + 400 });
    assert.equal(r.a.statusSnapshot('s').tasks, undefined, 'idle: no foreground call runs');
    await start('b1', T + 500, true);
    await r.hook({ sessionId: 's', kind: 'prompt', text: 'more', at: T + 600 });
    assert.deepEqual(r.a.statusSnapshot('s').tasks.map((t) => t.id), ['b1'], 'a background task runs past the turn');
    // The transcript still sees a shell of the previous claude process open (resumed): it died with that process.
    await r.hook({ sessionId: 's', kind: 'final', texts: [], at: T + 700,
      background: [{ id: 'old', kind: 'shell', label: 'npm run dev', startedAt: T - 3600000 }, { id: 'b1', kind: 'shell', label: 'b1', startedAt: T + 500 }] });
    assert.deepEqual(r.a.statusSnapshot('s').tasks.map((t) => t.id), ['b1']);
    ch.destroy();
  } finally { await r.a.close(); }
});

test('waiting: what a waiting session waits for is in its snapshot, and gone once it moves on', async () => {
  const r = await rig();
  try {
    const ch = await r.open();
    await r.rpc(ch, 'register', { sessionId: 's' });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'waiting-approval', text: 'Claude needs your permission to use Bash' });
    assert.deepEqual(r.a.statusSnapshot('s'), { state: 'waiting-approval', waiting: 'Claude needs your permission to use Bash' });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'running' });
    assert.equal(r.a.statusSnapshot('s').waiting, undefined);
    await r.rpc(ch, 'permission_request', { request_id: 'p', tool_name: 'Bash', description: 'Run the tests' });
    await r.hook({ sessionId: 's', kind: 'activity', state: 'waiting-approval', text: 'Claude needs your permission to use Bash' });
    assert.equal(r.a.statusSnapshot('s').waiting, 'Bash: Run the tests', 'the channel request says more than the notification');
    ch.destroy();
  } finally { await r.a.close(); }
});
