import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { turnTexts, mirrorFor, questionFor, answerOutput, deliverOutput, callHub, spool, flushSpool } from './bridge-hook.js';
import { ClaudeAdapter } from '../bridge/claude-adapter.mjs';

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

test('mirrorFor: prompt from payload, channel injections skipped, final prefers last_assistant_message', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'boot' };
  assert.deepEqual(mirrorFor({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' }, env),
    { sessionIds: ['s', 'boot'], kind: 'prompt', text: 'hi' });
  assert.equal(mirrorFor({ hook_event_name: 'UserPromptSubmit', prompt: '<channel source="session-bridge">x</channel>' }, env).text, '<channel source="session-bridge">x</channel>', 'passed through; the adapter unwraps it');
  assert.equal(mirrorFor({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, {}), null, 'no session id -> no-op');
  assert.deepEqual(mirrorFor({ hook_event_name: 'UserPromptSubmit', session_id: 'boot', prompt: 'hi' }, env).sessionIds, ['boot'], 'deduplicated');
  assert.deepEqual(mirrorFor({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'bye' }, env),
    { sessionIds: ['s', 'boot'], kind: 'final', texts: ['bye'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  try {
    const tp = path.join(dir, 't.jsonl');
    fs.writeFileSync(tp, [user('q'), asst([{ type: 'text', text: 'checking' }]), asst([{ type: 'text', text: 'from transcript' }])].join('\n'));
    assert.deepEqual(mirrorFor({ hook_event_name: 'Stop', transcript_path: tp }, env).texts, ['checking', 'from transcript']);
    assert.deepEqual(mirrorFor({ hook_event_name: 'Stop', transcript_path: tp, last_assistant_message: 'from transcript' }, env).texts,
      ['checking', 'from transcript'], 'the last message is not repeated');
    assert.deepEqual(mirrorFor({ hook_event_name: 'Stop', transcript_path: tp, last_assistant_message: 'not flushed yet' }, env).texts,
      ['checking', 'from transcript', 'not flushed yet'], 'a transcript lagging the last message');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(mirrorFor({ hook_event_name: 'Stop', transcript_path: '/nope' }, env), null);
});

test('mirrorFor: StopFailure (a turn ended by an API error) is a failed final', () => {
  assert.deepEqual(mirrorFor({ hook_event_name: 'StopFailure', session_id: 's', error_type: 'rate_limit', error_message: 'slow down' }, {}),
    { sessionIds: ['s'], kind: 'final', status: 'failed', text: 'rate_limit: slow down' });
  assert.equal(mirrorFor({ hook_event_name: 'StopFailure', session_id: 's' }, {}).text, 'unknown');
});

test('mirrorFor: tool use is activity, notifications map to states, SessionEnd ends unless it is a /clear', () => {
  const env = {};
  const at = (p) => mirrorFor({ session_id: 's', ...p }, env);
  assert.deepEqual(at({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), { sessionIds: ['s'], kind: 'activity', state: 'running' });
  assert.deepEqual(at({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_response: { answers: { 'Which?': 'A', 'Also?': ['x', 'y'] } } }),
    { sessionIds: ['s'], kind: 'answer', text: 'Which? -> A\nAlso? -> x, y' });
  assert.deepEqual(at({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    { sessionIds: ['s'], kind: 'activity', state: 'waiting-approval', text: 'Claude needs your permission to use Bash' });
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).text, undefined, 'idle is no news');
  assert.equal(at({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), null, 'a question is its own call');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).state, 'waiting-approval');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).state, 'idle');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }).state, 'waiting-input');
  assert.equal(at({ hook_event_name: 'Notification', notification_type: 'auth_success' }), null);
  assert.deepEqual(at({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }), { sessionIds: ['s'], kind: 'end' });
  assert.equal(at({ hook_event_name: 'SessionEnd', reason: 'clear' }), null, 'the process and its channel live on');
});

test('questionFor and answerOutput: AskUserQuestion only; answers ride updatedInput', () => {
  const tool_input = { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] };
  assert.deepEqual(questionFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's', tool_input }, {}),
    { sessionIds: ['s'], questions: tool_input.questions, wait: true });
  assert.equal(questionFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', tool_input }, {}), null);
  assert.equal(questionFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's', tool_input: {} }, {}), null);
  assert.deepEqual(answerOutput(tool_input, { 'Which?': 'A' }), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...tool_input, answers: { 'Which?': 'A' } } } });
});

test('callHub delivers to a live hub, and resolves quietly when none runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  const hub = new ClaudeAdapter();
  try {
    const port = await hub.listen(0);
    const runtimeFile = path.join(dir, 'runtime.json');
    fs.writeFileSync(runtimeFile, j({ port, token: hub.token }));
    assert.deepEqual(await callHub('mirror', { sessionIds: ['s'], kind: 'final', text: 'ok' }, { runtimeFile }), { ok: true, routed: false });
    assert.deepEqual(hub.held.map((h) => h.m), [{ sessionIds: ['s'], claudePid: null, retry: false, kind: 'final', text: 'ok' }], 'held until its session registers');
    assert.deepEqual(await callHub('question', { sessionIds: ['s'], questions: [{ question: 'q' }], wait: true }, { runtimeFile }), { answers: null });
    assert.equal(await callHub('mirror', { sessionIds: ['s'], kind: 'final', text: 'x' }, { runtimeFile: path.join(dir, 'none.json') }), null);
  } finally { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deliverOutput blocks the stop with the queued Telegram messages', () => {
  assert.equal(deliverOutput(undefined), null);
  assert.equal(deliverOutput([]), null);
  assert.deepEqual(deliverOutput([{ text: 'hi', user: 'u' }, { text: 'two', user: '' }]),
    { decision: 'block', reason: 'Message from Telegram (u):\nhi\n\nMessage from Telegram:\ntwo' });
});

test('spooled calls replay oldest first, marked; the first refusal or the budget re-spools the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-spool-'));
  const file = path.join(dir, 'spool.jsonl');
  const T = 4000000;
  try {
    spool({ kind: 'final', texts: ['stale'] }, { file, now: 0 });
    spool({ kind: 'prompt', text: 'one' }, { file, now: T });
    spool({ kind: 'final', texts: ['two'] }, { file, now: T + 1 });
    spool({ kind: 'final', texts: ['three'] }, { file, now: T + 2 });
    const sent = [];
    await flushSpool({ file, now: () => T + 10, send: async (c) => { sent.push(c); return c.kind === 'prompt' ? { ok: true } : null; } });
    assert.deepEqual(sent, [{ kind: 'prompt', text: 'one', replay: true }, { kind: 'final', texts: ['two'], replay: true }], 'stops at the refusal');
    // Out of budget after the first send: the rest goes back untried.
    sent.length = 0;
    let clock = T + 20;
    await flushSpool({ file, budgetMs: 100, now: () => clock, send: async (c) => { sent.push(c); clock += 200; return { ok: true }; } });
    assert.deepEqual(sent.map((c) => c.texts), [['two']]);
    sent.length = 0;
    await flushSpool({ file, now: () => clock, send: async (c, timeoutMs) => { assert.ok(timeoutMs > 0); sent.push(c); return { ok: true }; } });
    assert.deepEqual(sent.map((c) => c.texts), [['three']]);
    assert.equal(fs.existsSync(file), false);
    await flushSpool({ file, send: async () => assert.fail('nothing spooled') });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
