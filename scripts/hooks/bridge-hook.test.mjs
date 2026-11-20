import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { turnTexts, backgroundTasks, parseJsonl, mirrorFor, questionFor, questionOutput, deliverOutput, callHub, spool, readSpool,
  sendSpool, startSender, claudePidOfHook, outcomeOf, CALL_MS, LEASE_STALE_MS } from './bridge-hook.js';
import { ClaudeAdapter } from '../bridge/claude-adapter.mjs';

const HOOK = fileURLToPath(new URL('./bridge-hook.js', import.meta.url));

const j = (o) => JSON.stringify(o);
const user = (content) => j({ type: 'user', message: { role: 'user', content } });
const asst = (content) => j({ type: 'assistant', message: { role: 'assistant', content } });

test('turnTexts: text blocks after the last real user message only', () => {
  const lines = [
    user('old question'),
    asst([{ type: 'text', text: 'old answer' }]),
    user('new question'),
    asst([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't', content: 'file' }]),
    asst([{ type: 'text', text: 'Done.' }]),
    j({ type: 'system', subtype: 'x' }),
  ].join('\n');
  assert.deepEqual(turnTexts(lines), ['Let me look.', 'Done.']);
  assert.deepEqual(turnTexts(user('q')), []);
  assert.deepEqual(turnTexts('garbage\n' + user([{ type: 'text', text: 'q' }]) + '\n' + asst([{ type: 'text', text: 'a' }])), ['a']);
});

test('backgroundTasks: shells and agents started minus those notified or stopped, by their tool call; quoted text and old starts do not count', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const at = (iso, o) => j({ ...JSON.parse(o), timestamp: iso });
  const result = (text, id = 't') => user([{ type: 'tool_result', tool_use_id: id, content: text }]);
  const T = '2026-10-30T11:00:00Z';
  const lines = [
    at(T, result('Command running in background with ID: sh1. Output is being written to: x')),
    at(T, result('Command running in background with ID: sh2. Output is being written to: x', 'toolu_sh2')),
    at(T, result('Async agent launched successfully.\nagentId: ag1 (internal ID)')),
    at(T, result('Command running in background with ID: sh3.')),
    at('2026-10-28T00:00:00Z', result('Command running in background with ID: old1.')),
    at(T, result('grep says: Command running in background with ID: quoted')),
    at(T, asst([{ type: 'text', text: 'Command running in background with ID: said' }])),
    at(T, user('<task-notification>\n<task-id>sh1</task-id>\n<status>completed</status>\n</task-notification>')),
    at(T, j({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>ag1</task-id>\n<status>failed</status>' } })),
    at(T, result('{"message":"Successfully stopped task: sh3 (sleep 9)"}')),
  ];
  assert.deepEqual(backgroundTasks(lines.join('\n'), { now }), [{ id: 'toolu_sh2', kind: 'shell', label: '', startedAt: Date.parse(T) }],
    'sh2 still runs, known by its tool call (no call entry: its result time, no label)');
  const payload = { hook_event_name: 'Stop', session_id: 's', transcript_path: path.join(os.tmpdir(), `bg-${process.pid}.jsonl`) };
  const now2 = new Date().toISOString();
  fs.writeFileSync(payload.transcript_path, lines[1].replace(T, now2));
  try { assert.deepEqual(mirrorFor(payload), { sessionId: 's', kind: 'final', texts: [], background: [{ id: 'toolu_sh2', kind: 'shell', label: '', startedAt: Date.parse(now2) }] },
    'a textless turn end still reports its tasks'); }
  finally { fs.rmSync(payload.transcript_path, { force: true }); }
});

test('backgroundTasks: each open task as its call made it — kind, label, when it was called — so a restarted daemon gets it back', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const at = (iso, o) => j({ ...JSON.parse(o), timestamp: iso });
  const lines = [
    at('2026-10-30T11:00:00Z', asst([{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'Explore', description: 'find the hooks' } }])),
    at('2026-10-30T11:00:02Z', user([{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'Async agent launched successfully. (internal; never quote the agentId below)\nagentId: a82b002cad3813945 (internal ID)' }] }])),
    at('2026-10-30T11:01:00Z', asst([{ type: 'tool_use', id: 'toolu_p', name: 'PowerShell', input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true } }])),
    at('2026-10-30T11:01:01Z', user([{ type: 'tool_result', tool_use_id: 'toolu_p', content: 'Command running in background with ID: bp1. Output is being written to: x' }])),
  ];
  assert.deepEqual(backgroundTasks(lines.join('\n'), { now }), [
    { id: 'toolu_a', kind: 'agent', label: 'Explore: find the hooks', startedAt: Date.parse('2026-10-30T11:00:00Z') },
    { id: 'toolu_p', kind: 'powershell', label: 'Start the dev server', startedAt: Date.parse('2026-10-30T11:01:00Z') }]);
});

test('taskFor: a call that went to the background by itself (no run_in_background) still runs when it returns', () => {
  const post = (tool, response) => mirrorFor({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: tool, tool_use_id: 'u1', tool_input: {}, tool_response: response }, {}).task;
  assert.deepEqual(post('Agent', { content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a1 (internal ID)' }] }), { op: 'background', id: 'u1' });
  assert.deepEqual(post('Bash', { stdout: '', backgroundTaskId: 'b7' }), { op: 'background', id: 'u1' });
  assert.deepEqual(post('Bash', 'Command running in background with ID: b8. Output is being written to: x'), { op: 'background', id: 'u1' });
  assert.deepEqual(post('Bash', { stdout: 'done' }), { op: 'end', id: 'u1', status: 'completed' });
});

test('mirrorFor: prompt from payload, channel injections skipped, final prefers last_assistant_message', () => {
  const env = {};
  assert.deepEqual(mirrorFor({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' }, env),
    { sessionId: 's', kind: 'prompt', text: 'hi' });
  assert.equal(mirrorFor({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<channel source="session-bridge">x</channel>' }, env).text, '<channel source="session-bridge">x</channel>', 'passed through; the adapter unwraps it');
  assert.equal(mirrorFor({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, {}), null, 'no session id -> no-op');
  assert.deepEqual(mirrorFor({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'bye' }, env),
    { sessionId: 's', kind: 'final', texts: ['bye'], background: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  try {
    const tp = path.join(dir, 't.jsonl');
    fs.writeFileSync(tp, [user('q'), asst([{ type: 'text', text: 'checking' }]), asst([{ type: 'text', text: 'from transcript' }])].join('\n'));
    assert.deepEqual(mirrorFor({ session_id: 's', hook_event_name: 'Stop', transcript_path: tp }, env).texts, ['checking', 'from transcript']);
    assert.deepEqual(mirrorFor({ session_id: 's', hook_event_name: 'Stop', transcript_path: tp, last_assistant_message: 'from transcript' }, env).texts,
      ['checking', 'from transcript'], 'the last message is not repeated');
    assert.deepEqual(mirrorFor({ session_id: 's', hook_event_name: 'Stop', transcript_path: tp, last_assistant_message: 'not flushed yet' }, env).texts,
      ['checking', 'from transcript', 'not flushed yet'], 'a transcript lagging the last message');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(mirrorFor({ session_id: 's', hook_event_name: 'Stop', transcript_path: '/nope' }, env), { sessionId: 's', kind: 'final', texts: [], background: [] },
    'a textless turn end still ends the turn');
});

test('taskFor: a shell or an agent call is a task — started, ended, failed, or left running in the background', () => {
  const p = (event, tool, input = {}, extra = {}) => mirrorFor({ hook_event_name: event, session_id: 's', tool_name: tool, tool_use_id: 'u1', tool_input: input, ...extra }, {});
  assert.deepEqual(p('PreToolUse', 'Bash', { command: 'npm test' }),
    { sessionId: 's', kind: 'activity', state: 'running', task: { op: 'start', id: 'u1', kind: 'shell', label: 'npm test', background: false } });
  assert.equal(p('PreToolUse', 'Bash', { command: 'cd x && npm test', description: 'Run the unit tests' }).task.label, 'Run the unit tests', 'what it does, when said');
  assert.deepEqual(p('PreToolUse', 'Agent', { subagent_type: 'Explore', description: 'find hooks', run_in_background: true }).task,
    { op: 'start', id: 'u1', kind: 'agent', label: 'Explore: find hooks', background: true });
  assert.deepEqual(p('PreToolUse', 'Task', { description: 'old name' }).task.kind, 'agent');
  assert.deepEqual(p('PreToolUse', 'PowerShell', { command: 'Get-ChildItem', description: 'List the files' }).task,
    { op: 'start', id: 'u1', kind: 'powershell', label: 'List the files', background: false });
  assert.deepEqual(p('PreToolUse', 'Monitor', { command: 'tail -f x.log', description: 'errors in x.log', timeout_ms: 600000 }).task,
    { op: 'start', id: 'u1', kind: 'monitor', label: 'errors in x.log', background: true, timeoutMs: 600000 }, 'a monitor always watches in the background, until it expires');
  assert.equal(p('PreToolUse', 'Monitor', { ws: { url: 'wss://x.test/s' }, description: '', timeout_ms: 9e6 }).task.timeoutMs, 1800000, 'capped as Claude Code caps it');
  assert.equal(p('PreToolUse', 'Monitor', { ws: { url: 'wss://x.test/s' } }).task.label, 'wss://x.test/s');
  assert.equal(p('PostToolUse', 'Monitor', { description: 'x' }).task, undefined, 'its call returns at once: it still watches');
  assert.deepEqual(p('PostToolUse', 'Bash', { command: 'ls' }).task, { op: 'end', id: 'u1', status: 'completed' });
  assert.equal(p('PostToolUse', 'Bash', { command: 'npm run dev', run_in_background: true }).task, undefined, 'still running: its end is read at a later Stop');
  assert.deepEqual(p('PostToolUseFailure', 'Bash', { command: 'false' }).task, { op: 'end', id: 'u1', status: 'failed' });
  assert.deepEqual(p('PostToolUseFailure', 'Agent', {}, { is_interrupt: true }).task, { op: 'end', id: 'u1', status: 'stopped' });
  assert.equal(p('PostToolUseFailure', 'Bash').state, 'running', 'a failed tool is still activity');
});

test('mirrorFor: StopFailure (a turn ended by an API error) is a failed final', () => {
  assert.deepEqual(mirrorFor({ hook_event_name: 'StopFailure', session_id: 's', error_type: 'rate_limit', error_message: 'slow down' }, {}),
    { sessionId: 's', kind: 'final', status: 'failed', text: 'rate_limit: slow down' });
  assert.equal(mirrorFor({ hook_event_name: 'StopFailure', session_id: 's' }, {}).text, 'unknown');
});

test('mirrorFor: tool use is activity, notifications map to states, SessionEnd is not mirrored', () => {
  const env = {};
  const at = (p) => mirrorFor({ session_id: 's', ...p }, env);
  assert.deepEqual(at({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), { sessionId: 's', kind: 'activity', state: 'running' });
  assert.deepEqual(at({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_response: { answers: { 'Which?': 'A', 'Also?': ['x', 'y'] } } }),
    { sessionId: 's', kind: 'answer', text: 'Which? -> A\nAlso? -> x, y' });
  assert.deepEqual(at({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    { sessionId: 's', kind: 'activity', state: 'waiting-approval', text: 'Claude needs your permission to use Bash' });
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).text, undefined, 'idle is no news');
  assert.equal(at({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), null, 'a question is its own call');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).state, 'waiting-approval');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).state, 'idle');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }).state, 'waiting-input');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'auth_success' }), null);
  for (const reason of ['prompt_input_exit', 'clear', 'resume', 'other'])
    assert.equal(at({ hook_event_name: 'SessionEnd', reason }), null, `${reason}: the channel socket closing is the only end signal`);
});

test('questionFor and questionOutput: AskUserQuestion only; a question posted to Telegram denies the dialog, never waits', () => {
  const tool_input = { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] };
  assert.deepEqual(questionFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's', tool_input }, {}),
    { sessionId: 's', questions: tool_input.questions, wait: true });
  assert.equal(questionFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', tool_input }, {}), null);
  assert.equal(questionFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's', tool_input: {} }, {}), null);
  const out = questionOutput({ posted: true });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Telegram/);
  assert.equal(questionOutput({ answers: null }), null, 'a locally typed turn shows the terminal dialog');
  assert.equal(questionOutput(null), null, 'no bridge: the terminal dialog');
});

test('claudePidOfHook reads the CLAUDE_PID Claude Code gives its hooks; none outside Claude Code', () => {
  assert.equal(claudePidOfHook({ CLAUDE_PID: '59760' }), 59760);
  assert.equal(claudePidOfHook({}), undefined);
  assert.equal(claudePidOfHook({ CLAUDE_PID: 'x' }), undefined);
});

/** A real adapter on 127.0.0.1 with a session `boot` registered under claude process 4242, its runtime file in `bridge`. */
async function liveAdapter(bridge, { register = true } = {}) {
  const a = new ClaudeAdapter();
  const port = await a.listen(0);
  fs.writeFileSync(path.join(bridge, 'runtime.json'), j({ port, token: a.token }));
  const prompts = [];
  a.on('prompt', (e) => prompts.push([e.id, e.text]));
  let ch = null;
  const registerBoot = () => new Promise((resolve) => {
    ch = net.connect({ host: '127.0.0.1', port }, () => ch.write(j({ jsonrpc: '2.0', id: 1, method: 'register', params: { token: a.token, sessionId: 'boot', cwd: '/repo', claudePid: 4242 } }) + '\n'));
    ch.setEncoding('utf8');
    ch.on('data', () => resolve());
  });
  if (register) await registerBoot();
  return { a, prompts, registerBoot, close: async () => { ch?.destroy(); await a.close(); } };
}

test('a missed SessionStart is healed by the next UserPromptSubmit: the hook names its claude process itself', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-home-'));
  const bridge = path.join(home, '.claude', 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  const live = await liveAdapter(bridge);
  try {
    // A renamed session (/clear, /resume, a fork) whose SessionStart never ran or learned anything.
    await runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 'cleared-new-id', prompt: 'after clear' }, [], { CLAUDE_PID: '4242' });
    assert.deepEqual(live.prompts, [['boot', 'after clear']], 'its first prompt routes to the session of its claude process');
    await runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 'unnamed-id', prompt: 'no process named' });
    assert.deepEqual(live.prompts, [['boot', 'after clear']], 'PLANTED CONTROL: a hook naming no process routes nothing...');
    assert.ok(readSpool(path.join(bridge, 'spool.jsonl')).concat(readSpool(path.join(bridge, 'spool.inflight.jsonl'))).some((e) => e.call.text === 'no process named'),
      '...and its call is spooled, never dropped');
  } finally {
    await live.close();
    await until(() => !fs.existsSync(path.join(bridge, 'spool.lease')), 15_000);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('callHub delivers to a live hub, and resolves quietly when none runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  const hub = new ClaudeAdapter();
  try {
    const port = await hub.listen(0);
    const runtimeFile = path.join(dir, 'runtime.json');
    fs.writeFileSync(runtimeFile, j({ port, token: hub.token }));
    assert.deepEqual(await callHub('mirror', { sessionId: 's', kind: 'final', text: 'ok' }, { runtimeFile }), { ok: true, routed: false });
    assert.deepEqual(await callHub('question', { sessionId: 's', questions: [{ question: 'q' }], wait: true }, { runtimeFile }), { answers: null });
    assert.equal(await callHub('mirror', { sessionId: 's', kind: 'final', text: 'x' }, { runtimeFile: path.join(dir, 'none.json') }), null);
  } finally { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deliverOutput blocks the stop with the queued Telegram messages', () => {
  assert.equal(deliverOutput(undefined), null);
  assert.equal(deliverOutput([]), null);
  assert.deepEqual(deliverOutput([{ text: 'hi', user: 'u' }, { text: 'two', user: '' }]),
    { decision: 'block', reason: 'Message from Telegram (u):\nhi\n\nMessage from Telegram:\ntwo' });
});

// ── The spool: a call the daemon did not take is never lost and never waited for ──
// Every hook < 5 s for the whole event (user ruling D24): the hook makes at most ONE bounded call,
// spools what the daemon did not take, and a detached sender delivers the spool in order.

const spoolFiles = (dir) => {
  const runtimeFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtimeFile, '{}');
  return { file: path.join(dir, 'spool.jsonl'), inflight: path.join(dir, 'spool.inflight.jsonl'), cursor: path.join(dir, 'spool.inflight.cursor'),
    held: path.join(dir, 'spool.held.jsonl'), lease: path.join(dir, 'spool.lease'), runtimeFile, claimGraceMs: 0 };
};

// The mirror loses nothing (standing user ruling): delivery is the ONLY way an entry leaves the
// spool -- no age or count eviction; an entry the daemon refuses is held and surfaced, never dropped.

test('delivery is the only way out: 1,500 entries older than a day all reach the daemon, in order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  const old = Date.now() - 2 * 86400000;
  try {
    for (let i = 0; i < 1500; i++) spool({ kind: 'prompt', text: `m${i}` }, { file: f.file, now: old + i });
    const sent = [];
    let up = false, clock = 0;
    const send = async (c) => { if (!up) return null; sent.push(c.text); return { ok: true, routed: true }; };
    await sendSpool({ ...f, send, sleep: async (ms) => { clock += ms; if (clock > 1000) up = true; }, now: () => clock, lifetimeMs: 10 * 60000, lingerMs: 0 });
    assert.equal(sent.length, 1500, 'every entry, however old, is delivered once the daemon is up');
    assert.deepEqual(sent, Array.from({ length: 1500 }, (_, i) => `m${i}`), 'in order');
    assert.equal(fs.existsSync(f.file) || fs.existsSync(f.inflight), false, 'only now is the spool empty');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a daemon that never acks, or never routes, keeps every entry; only a routed ack releases one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  try {
    for (let i = 0; i < 5; i++) spool({ sessionId: 's', kind: 'prompt', text: `k${i}` }, { file: f.file, now: Date.now() + i });
    const answers = [null, {}, { ok: false }, { error: { code: -32001, message: 'unauthorized' } }, { routed: true }, { ok: true, routed: false }];
    let n = 0, clock = 0;
    const tries = async () => answers[n++ % answers.length];
    await sendSpool({ ...f, send: tries, sleep: async (ms) => { clock += ms; }, now: () => clock, lifetimeMs: 60_000, lingerMs: 0 });
    assert.ok(n >= answers.length, `PLANTED CONTROL: every answer short of a routed ack was tried (${n} tries)`);
    assert.deepEqual(readSpool(f.inflight).map((e) => e.call.text), ['k0', 'k1', 'k2', 'k3', 'k4'], 'nothing left the spool');
    assert.equal(fs.existsSync(f.held), false, 'no answer short of a refusal holds an entry');
    assert.deepEqual(['delivered', 'delivered', 'unrouted', 'refused', 'retry'].map((x, i) => x === outcomeOf([{ ok: true }, { ok: true, routed: false, nested: true }, { ok: true, routed: false }, { error: { code: -32602 } }, null][i])), [true, true, true, true, true]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a call waiting for its channel survives past 30 s and is delivered once the session is routable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  const live = await liveAdapter(dir, { register: false });
  f.runtimeFile = path.join(dir, 'runtime.json');
  try {
    // Its claude process is named (CLAUDE_PID) but no channel is registered under it yet.
    spool({ sessionId: 'cleared', claudePid: 4242, kind: 'prompt', text: 'typed early' }, { file: f.file, now: Date.now() });
    let clock = 0, registered = false, seenAt31 = null;
    const sleep = async (ms) => {
      clock += ms;
      if (clock > 31_000 && !registered) {
        seenAt31 = [...live.prompts];
        registered = true;
        await live.registerBoot();   // the channel of process 4242 comes up after 31 s
      }
    };
    await sendSpool({ ...f, sleep, now: () => clock, lifetimeMs: 120_000, lingerMs: 0, alive: () => true, send: (c) => callHub('mirror', c, { runtimeFile: f.runtimeFile }) });
    assert.deepEqual(seenAt31, [], 'PLANTED CONTROL: nothing routed in the first 31 s');
    assert.deepEqual(live.prompts, [['boot', 'typed early']], 'delivered once its channel registered, after the old 30 s drop');
    assert.equal(fs.existsSync(f.inflight) || fs.existsSync(f.file), false);
  } finally { await live.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one session waiting for its channel never blocks another; a session whose process exited unrouted is held', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  try {
    spool({ sessionId: 'waiting', claudePid: 10, kind: 'prompt', text: 'w1' }, { file: f.file, now: 1 });
    spool({ sessionId: 'live', claudePid: 20, kind: 'prompt', text: 'l1' }, { file: f.file, now: 2 });
    spool({ sessionId: 'waiting', claudePid: 10, kind: 'final', text: 'w2' }, { file: f.file, now: 3 });
    spool({ sessionId: 'gone', claudePid: 30, kind: 'final', text: 'g1' }, { file: f.file, now: 4 });
    spool({ sessionId: 'live', claudePid: 20, kind: 'final', text: 'l2' }, { file: f.file, now: 5 });
    const sent = [];
    const send = async (c) => { sent.push(c.text); return c.sessionId === 'live' ? { ok: true, routed: true } : { ok: true, routed: false }; };
    let clock = 0;
    await sendSpool({ ...f, send, sleep: async (ms) => { clock += ms; }, now: () => clock, lifetimeMs: 3000, lingerMs: 0, alive: (pid) => pid !== 30 });
    assert.deepEqual(sent.slice(0, 4), ['w1', 'l1', 'g1', 'l2'], 'a waiting session\'s later call is not tried behind its first; the others flow');
    assert.deepEqual(readSpool(f.inflight).map((e) => e.call.text), ['w1', 'w2'], 'the waiting session keeps its calls, in order');
    assert.match(fs.readFileSync(f.held, 'utf8'), /"g1"/, 'an exited process\'s unroutable call is held, not dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an entry the daemon refuses, or a torn line, is held and surfaced, never dropped; the rest flows on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  try {
    spool({ kind: 'prompt', text: 'a' }, { file: f.file, now: 1 });
    spool({ kind: 'bogus', text: 'refused' }, { file: f.file, now: 2 });
    fs.appendFileSync(f.file, '{"at":3,"call":{"kind":"fin\n');
    spool({ kind: 'prompt', text: 'b' }, { file: f.file, now: 4 });
    const sent = [];
    const send = async (c) => (c.kind === 'bogus' ? { error: { code: -32602, message: 'bad kind' } } : (sent.push(c.text), { ok: true }));
    let clock = 0;
    await sendSpool({ ...f, send, sleep: async (ms) => { clock += ms; }, now: () => clock, lifetimeMs: 60_000, lingerMs: 0 });
    assert.deepEqual(sent, ['a', 'b']);
    const held = fs.readFileSync(f.held, 'utf8');
    assert.match(held, /"refused"/, 'the refused entry is kept');
    assert.match(held, /"kind":"fin/, 'the torn line is kept, raw');
    const { checkBridgeSpool } = await import('../setup/doctor.js');
    const findings = checkBridgeSpool({ dir });
    assert.ok(findings.some((x) => x.level === 'FAIL' && x.id === 'bridge-spool-held' && /2 /.test(x.title)), 'doctor counts the held entries');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sender delivers the spool oldest first, marked as replays; a refusal keeps the rest for a later try', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  const T = Date.now();
  try {
    spool({ kind: 'prompt', text: 'one' }, { file: f.file, now: T });
    spool({ kind: 'final', texts: ['two'] }, { file: f.file, now: T + 1 });
    fs.appendFileSync(f.file, '{"at":3,"call":{"kind":"fin\n');   // a half-written line is skipped, never fatal
    spool({ kind: 'final', texts: ['three'] }, { file: f.file, now: T + 2 });
    const sent = [];
    let up = false;
    const send = async (c) => { if (!up) return null; sent.push(c); return { ok: true }; };
    let clock = 0;
    const sleep = async (ms) => { clock += ms; if (clock > 2000) up = true; };
    await sendSpool({ ...f, send, sleep, now: () => clock, lifetimeMs: 60_000, lingerMs: 0 });
    assert.deepEqual(sent, [{ kind: 'prompt', text: 'one', replay: true }, { kind: 'final', texts: ['two'], replay: true }, { kind: 'final', texts: ['three'], replay: true }],
      'PLANTED CONTROL: nothing reached a daemon that was down; all three once it came up, in order');
    assert.equal(fs.existsSync(f.file) || fs.existsSync(f.inflight), false, 'the spool is drained');
    assert.equal(fs.existsSync(f.lease), false, 'the lease is released');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sender that runs out of lifetime keeps every undelivered call for the next one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const f = spoolFiles(dir);
  try {
    spool({ kind: 'prompt', text: 'kept' }, { file: f.file, now: Date.now() });
    let clock = 0;
    await sendSpool({ ...f, send: async () => null, sleep: async (ms) => { clock += ms; }, now: () => clock, lifetimeMs: 5000, lingerMs: 0 });
    assert.deepEqual(readSpool(f.inflight).map((e) => e.call.text), ['kept']);
    assert.equal(fs.existsSync(f.lease), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one sender at a time: a fresh lease starts none, a stale one is taken over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lease-'));
  const f = spoolFiles(dir);
  try {
    const started = [];
    const start = () => started.push(1);
    assert.equal(startSender({ lease: f.lease, start }), true, 'PLANTED CONTROL: no sender runs, so one starts');
    fs.writeFileSync(f.lease, String(process.pid));
    assert.equal(startSender({ lease: f.lease, start }), false, 'a sender holds a fresh lease');
    const old = new Date(Date.now() - LEASE_STALE_MS - 1000);
    fs.utimesSync(f.lease, old, old);
    assert.equal(startSender({ lease: f.lease, start }), true, 'a lease nobody renews belongs to a dead sender');
    assert.equal(started.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A planted daemon on 127.0.0.1: `mode` ok | hung. Resolves {port, got, close}. */
function plantedDaemon(mode = 'ok', port = 0) {
  const got = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        got.push(req.params);
        if (mode === 'ok') sock.write(j({ jsonrpc: '2.0', id: req.id, result: { ok: true, routed: true } }) + '\n');
      }
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ port: server.address().port, got, close: () => new Promise((c) => server.close(c)) })));
}

/** Run bridge-hook.js as Claude Code does, under a planted home. Resolves {ms, code, out}. */
function runHook(home, payload, args = [], env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', ...env }, windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ ms: Date.now() - t0, code, out }));
    c.stdin.end(j(payload));
  });
}

async function until(cond, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (cond()) return true;
  return cond();
}

test('an unreachable bridge: the hook spools the prompt and returns at once; the detached sender delivers it when the bridge is up', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-home-'));
  const bridge = path.join(home, '.claude', 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  const probe = await plantedDaemon();
  const port = probe.port;
  await probe.close();   // nothing listens: the daemon is down
  fs.writeFileSync(path.join(bridge, 'runtime.json'), j({ port, token: 't'.repeat(48) }));
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'mirror me' };
  try {
    const r = await runHook(home, prompt);
    assert.equal(r.code, 0);
    assert.ok(r.ms < CALL_MS + 2500, `the hook took ${r.ms} ms`);
    assert.ok(fs.existsSync(path.join(bridge, 'spool.jsonl')) || fs.existsSync(path.join(bridge, 'spool.inflight.jsonl')), 'the prompt is spooled, never dropped');
    const daemon = await plantedDaemon('ok', port);   // the bridge comes back on its port
    try {
      assert.ok(await until(() => daemon.got.some((p) => p.text === 'mirror me')), 'the detached sender delivered the spooled prompt');
      assert.equal(daemon.got.find((p) => p.text === 'mirror me').replay, true);
      assert.ok(await until(() => !fs.existsSync(path.join(bridge, 'spool.lease'))), 'the sender ends once the spool is drained');
    } finally { await daemon.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a hung bridge costs a hook one bounded call, and the call is spooled; a live bridge takes it directly', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-home-'));
  const bridge = path.join(home, '.claude', 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  const stop = { hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'the answer' };
  const live = await plantedDaemon('ok');
  try {
    fs.writeFileSync(path.join(bridge, 'runtime.json'), j({ port: live.port, token: 't'.repeat(48) }));
    const direct = await runHook(home, stop);
    assert.ok(live.got.some((p) => p.kind === 'final' && p.texts.includes('the answer')), 'PLANTED CONTROL: a live bridge gets the final directly');
    assert.equal(fs.existsSync(path.join(bridge, 'spool.jsonl')), false);
    assert.equal(direct.code, 0);
  } finally { await live.close(); }
  const hung = await plantedDaemon('hung');
  try {
    fs.writeFileSync(path.join(bridge, 'runtime.json'), j({ port: hung.port, token: 't'.repeat(48) }));
    const r = await runHook(home, stop);
    assert.ok(r.ms < CALL_MS + 2500, `a hung bridge held the Stop hook ${r.ms} ms`);
    assert.ok(readSpool(path.join(bridge, 'spool.jsonl')).concat(readSpool(path.join(bridge, 'spool.inflight.jsonl'))).some((e) => e.call.kind === 'final'),
      'the final the bridge did not take is spooled');
  } finally {
    await hung.close();
    await until(() => !fs.existsSync(path.join(bridge, 'spool.lease')), 15_000);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a pending spool is drained by a PreToolUse or PostToolUse hook, with no Stop', async () => {
  for (const [label, payload, args] of [
    ['PreToolUse(AskUserQuestion) --question', { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'q?' }] } }, ['--question']],
    ['PostToolUse(Read)', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_use_id: 'u1', tool_input: {} }, []],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-home-'));
    const bridge = path.join(home, '.claude', 'bridge');
    fs.mkdirSync(bridge, { recursive: true });
    const daemon = await plantedDaemon('ok');
    try {
      fs.writeFileSync(path.join(bridge, 'runtime.json'), j({ port: daemon.port, token: 't'.repeat(48) }));
      spool({ sessionId: 's', kind: 'final', texts: [`left by a Stop (${label})`] }, { file: path.join(bridge, 'spool.jsonl'), now: Date.now() - 86400000 });
      const r = await runHook(home, payload, args);
      assert.equal(r.code, 0);
      assert.ok(r.ms < CALL_MS + 2500, `${label} took ${r.ms} ms`);
      assert.ok(await until(() => daemon.got.some((p) => p.texts?.[0] === `left by a Stop (${label})` && p.replay === true), 20_000),
        `${label} started the sender, which delivered the spooled final`);
      assert.ok(await until(() => !fs.existsSync(path.join(bridge, 'spool.lease')), 15_000));
      assert.equal(fs.existsSync(path.join(bridge, 'spool.jsonl')) || fs.existsSync(path.join(bridge, 'spool.inflight.jsonl')), false, 'drained');
    } finally {
      await daemon.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('turnTexts: a message from Telegram starts a turn — by the channel or through the Stop hook', () => {
  const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const viaChannel = JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'channel', server: 'session-bridge' }, message: { content: '<channel source="session-bridge">B</channel>' } });
  const viaStop = JSON.stringify({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback:\nMessage from Telegram (u):\nB' } });
  const otherMeta = JSON.stringify({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback:\nrun the review' } });
  for (const b of [viaChannel, viaStop]) {
    assert.deepEqual(turnTexts([JSON.stringify({ type: 'user', message: { content: 'A?' } }), say('AAAA'), b, say('C')].join('\n')), ['C'], 'the reply to B is C alone, not AAAA again');
  }
  assert.deepEqual(turnTexts([JSON.stringify({ type: 'user', message: { content: 'A?' } }), say('AAAA'), otherMeta, say('C')].join('\n')), ['C'],
    'any Stop-hook continuation: the Stop before it already mirrored AAAA');
});

test('turnTexts and backgroundTasks take entries parsed once, as Stop reads a large transcript once', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: 'q' } }),
    'partial {',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }),
  ].join('\n');
  const entries = parseJsonl(jsonl);
  assert.equal(entries.length, 2, 'a partial line is skipped');
  assert.deepEqual(turnTexts(entries), turnTexts(jsonl));
  assert.deepEqual(backgroundTasks(entries), backgroundTasks(jsonl));
});

test('mirrorFor: a TaskStop ends the task its call started, found by its task id in the transcript — a monitor stopped early', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-stop-'));
  const file = path.join(dir, 't.jsonl');
  const result = (text, id) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  fs.writeFileSync(file, [
    result('Monitor started (task bmon1, expires in 30m unless the source ends first; ...)', 'toolu_mon'),
    result('Command running in background with ID: bsh1. Output is being written to: x', 'toolu_sh'),
    result('grep says: Monitor started (task bquoted, expires', 'toolu_q'),
  ].join('\n') + '\n');
  const stop = (taskId, event = 'PostToolUse') => mirrorFor({ hook_event_name: event, session_id: 's', tool_name: 'TaskStop', tool_use_id: 'u9',
    tool_input: { task_id: taskId }, tool_response: { message: `Successfully stopped task: ${taskId} (x)` }, transcript_path: file });
  assert.deepEqual(stop('bmon1').task, { op: 'end', id: 'toolu_mon', status: 'stopped' });
  assert.deepEqual(stop('bsh1').task, { op: 'end', id: 'toolu_sh', status: 'stopped' });
  assert.equal(stop('bquoted').task, undefined, 'only a tool result that starts with the start line counts');
  assert.equal(stop('bnone').task, undefined);
  assert.equal(stop('bmon1', 'PreToolUse').task, undefined, 'not yet stopped');
  fs.rmSync(dir, { recursive: true, force: true });
});
