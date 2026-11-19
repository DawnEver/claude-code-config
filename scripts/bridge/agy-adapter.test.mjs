import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AgyAdapter, agyCallFor, agyNeedsApproval, agyPromptText, agyQuestions, agyTurnTexts,
  forwardAgyHook, isAgyMainSession, readAgyCwds, toolTaskId,
} from './agy-adapter.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { Bridge } from './daemon.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
};

function collect(a) {
  const ev = [];
  for (const k of ['up', 'down', 'status', 'prompt', 'progress', 'final', 'notice', 'question', 'question-resolved', 'approval', 'approval-resolved']) {
    a.on(k, (e) => ev.push([k, e]));
  }
  return ev;
}

function fakeTelegram() {
  const t = { sent: [], edits: [], topics: [], answers: [] };
  let nextTopic = 100, nextMsg = 1;
  Object.assign(t, {
    createForumTopic: async (chatId, name) => { t.topics.push([chatId, name]); return { message_thread_id: nextTopic++ }; },
    editForumTopic: async () => true,
    sendMessage: async (chatId, text, opts = {}) => { const message_id = nextMsg++; t.sent.push({ chatId, text, ...opts, message_id }); return [{ message_id }]; },
    editMessageText: async (chatId, id, text, options = {}) => { t.edits.push({ chatId, id, text, ...options }); },
    answerCallbackQuery: async (id, text) => { t.answers.push(text); },
    closeForumTopic: async () => true,
    reopenForumTopic: async () => true,
    deleteForumTopic: async () => true,
    deleteMessage: async () => true,
    pinChatMessage: async () => true,
  });
  return t;
}

test('a turn: up on the first hook, prompt, tool task, final at Stop, idle', () => {
  let t = 1000;
  const a = new AgyAdapter({ now: () => t });
  const ev = collect(a);
  a.handle({ sessionId: 'c1', event: 'SessionStart', cwd: '/w', at: 1 });
  a.handle({ sessionId: 'c1', event: 'PreInvocation', invocationNum: 1, text: 'hello', at: 2 });
  assert.deepEqual(ev.filter(([k]) => k === 'up').map(([, e]) => e.cwd), ['/w']);
  assert.deepEqual(ev.filter(([k]) => k === 'prompt').map(([, e]) => e.text), ['hello']);
  const tc = { name: 'run_command', args: { CommandLine: 'npm test' } };
  a.handle({ sessionId: 'c1', event: 'PreToolUse', toolCall: tc, invocationNum: 1, at: 3 });
  assert.equal(a.statusSnapshot('c1').state, 'running');
  assert.equal(a.statusSnapshot('c1').tasks[0].label, 'npm test');
  a.handle({ sessionId: 'c1', event: 'PostToolUse', toolCall: tc, invocationNum: 1, at: 4 });
  assert.equal(a.statusSnapshot('c1').tasks, undefined);
  assert.ok(ev.some(([k]) => k === 'progress'));
  const r = a.handle({ sessionId: 'c1', event: 'Stop', texts: ['done'], at: 5 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(ev.filter(([k]) => k === 'final').map(([, e]) => e.text), ['done']);
  assert.equal(a.statusSnapshot('c1').state, 'idle');
  // A repeated Stop with the same blocks sends nothing new.
  a.handle({ sessionId: 'c1', event: 'Stop', texts: ['done'], at: 6 });
  assert.equal(ev.filter(([k]) => k === 'final').length, 1);
});

test('Telegram messages queue (on disk) and are delivered by the next Stop', async () => {
  const queueDir = tmp();
  const a = new AgyAdapter({ queueDir });
  a.handle({ sessionId: 'c2', event: 'PreInvocation', invocationNum: 1, text: 'x' });
  const q = await a.inject('c2', 'from phone', 'ann');
  assert.equal(q.queued, true);
  // A restart keeps it: a new adapter loads the queue when the session comes up.
  const b = new AgyAdapter({ queueDir });
  const r = b.handle({ sessionId: 'c2', event: 'Stop', texts: ['ok'] });
  assert.deepEqual(r.deliver, [{ text: 'from phone', user: 'ann', userId: '' }]);
  assert.equal(b.statusSnapshot('c2').state, 'running');
  assert.equal(b.handle({ sessionId: 'c2', event: 'Stop', texts: ['ok2'] }).deliver, undefined);
  // A continuation's PreInvocation is not a typed prompt.
  const ev = collect(b);
  b.handle({ sessionId: 'c2', event: 'PreInvocation', invocationNum: 1, text: 'Message from Telegram', continuationActive: true });
  assert.equal(ev.filter(([k]) => k === 'prompt').length, 0);
});

test('a silent session goes down; bad calls are refused', () => {
  let t = 0;
  const a = new AgyAdapter({ now: () => t, idleDownMs: 100, runningDownMs: 1000 });
  const ev = collect(a);
  a.handle({ sessionId: 'c3', event: 'SessionStart' });
  t = 50; a.sweep();
  assert.ok(!ev.some(([k]) => k === 'down'));
  t = 200; a.sweep();
  assert.deepEqual(ev.filter(([k]) => k === 'down').map(([, e]) => e.id), ['c3']);
  assert.equal(a.statusSnapshot('c3').state, 'disconnected');
  assert.throws(() => a.handle({ sessionId: '', event: 'Stop' }));
  assert.throws(() => a.handle({ sessionId: 'x', event: 'Nope' }));
});

test('the workspace of each conversation is noted for the usage store', () => {
  const cwdFile = path.join(tmp(), 'agy-cwd.json');
  const a = new AgyAdapter({ cwdFile });
  a.handle({ sessionId: 'c4', event: 'SessionStart', cwd: '/repo' });
  assert.deepEqual(readAgyCwds(cwdFile), { c4: '/repo' });
});

test('hook side: payload mapping, settings toolPermission, transcript texts, prompt envelope', () => {
  const dir = tmp();
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, [
    { type: 'USER_INPUT', content: 'q1' }, { type: 'PLANNER_RESPONSE', content: 'old' },
    { type: 'USER_INPUT', content: 'q2' }, { type: 'PLANNER_RESPONSE', content: '' }, { type: 'PLANNER_RESPONSE', content: 'a' }, { type: 'PLANNER_RESPONSE', content: 'b' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual(agyTurnTexts(file), ['a', 'b']);
  assert.equal(agyPromptText('<USER_REQUEST>\nhi there\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), 'hi there');
  const c = agyCallFor('Stop', { conversationId: 'c', workspacePaths: ['/w'], transcriptPath: file, terminationReason: 'done' });
  assert.equal(c.cwd, '/w');
  assert.deepEqual(c.texts, ['a', 'b']);
  const settingsAlways = path.join(dir, 'always.json');
  fs.writeFileSync(settingsAlways, JSON.stringify({ toolPermission: 'always-proceed' }));
  const settingsAsk = path.join(dir, 'ask.json');
  fs.writeFileSync(settingsAsk, JSON.stringify({ toolPermission: 'request-review' }));
  assert.equal(agyNeedsApproval('run_command', settingsAlways), false);
  assert.equal(agyNeedsApproval('run_command', settingsAsk), true);
  assert.equal(agyNeedsApproval('write_file', settingsAsk), true);
  assert.equal(agyNeedsApproval('edit_file', settingsAsk), true);
  assert.equal(agyNeedsApproval('read_file', settingsAsk), false);
  const pAlways = agyCallFor('PreToolUse', { conversationId: 'c', cwd: '/x', toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, invocationNum: 2 }, { settingsFile: settingsAlways });
  assert.equal(pAlways.cwd, '/x');
  assert.equal(pAlways.toolCall.name, 'run_command');
  assert.equal(pAlways.needsApproval, undefined);
  const pAsk = agyCallFor('PreToolUse', { conversationId: 'c', toolCall: { name: 'edit_file', args: { Path: '/a' } } }, { settingsFile: settingsAsk });
  assert.equal(pAsk.needsApproval, true);
  assert.equal(toolTaskId('c', 2, pAlways.toolCall), toolTaskId('c', 2, { name: 'run_command', args: { CommandLine: 'ls' } }));
  assert.deepEqual(agyQuestions({ questions: [{ question: 'Pick?', options: ['A', 'B'], is_multi_select: true }] }), [{
    id: '0', header: '', question: 'Pick?', isOther: true, isSecret: false, multiSelect: true,
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
  }]);
});

test('forwardAgyHook contract: { injectSteps?, stopContinue?, decision?, reason?, terminate? } and fail-open {}', async () => {
  const none = path.join(tmp(), 'runtime.json');
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: none }), {});
  const rt = path.join(tmp(), 'runtime.json');
  fs.writeFileSync(rt, '{}');
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: rt, call: async () => ({ ok: true, deliver: [{ text: 'hi', user: 'ann' }] }) }),
    { stopContinue: 'Message from Telegram (ann):\nhi' });
  assert.deepEqual(await forwardAgyHook('PreToolUse', { conversationId: 'c', toolCall: { name: 'ask_question' } }, { runtimeFile: rt, call: async () => ({ ok: true, decision: 'deny', reason: 'User answered via Telegram:\nQ -> A' }) }),
    { decision: 'deny', reason: 'User answered via Telegram:\nQ -> A' });
  assert.deepEqual(await forwardAgyHook('PreToolUse', { conversationId: 'c', toolCall: { name: 'run_command' } }, { runtimeFile: rt, call: async () => ({ ok: true, decision: 'allow' }) }),
    { decision: 'allow' });
  assert.deepEqual(await forwardAgyHook('PreInvocation', { conversationId: 'c' }, { runtimeFile: rt, call: async () => ({ ok: true, terminate: true, reason: 'Interrupted from Telegram.' }) }),
    { terminate: true, reason: 'Interrupted from Telegram.' });
  assert.deepEqual(await forwardAgyHook('SessionStart', { conversationId: 'c' }, { runtimeFile: rt, call: async () => ({ ok: true, injectSteps: [{ systemMessage: { systemMessage: 'hi' } }] }) }),
    { injectSteps: [{ systemMessage: { systemMessage: 'hi' } }] });
  assert.deepEqual(await forwardAgyHook('PostToolUse', { conversationId: 'c' }, { runtimeFile: rt, call: async () => ({ ok: true }) }), {});
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: rt, call: async () => null }), {});
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: rt, call: async () => ({ error: { code: 401 } }) }), {});
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: rt, call: async () => { throw new Error('x'); } }), {});
});

test('isAgyMainSession: keeps only top-level interactive main sessions and syncs conversation Title', async () => {
  const appDir = tmp();
  fs.mkdirSync(path.join(appDir, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'presence'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'presence', 'main-1.lock'), '');
  fs.writeFileSync(path.join(appDir, 'presence', 'print-1.lock'), '');
  fs.writeFileSync(path.join(appDir, 'cache', 'conversation_metadata.json'), JSON.stringify({
    conversations: {
      'main-1': { is_internal: false, summary: { Title: 'Refactor Harness', Internal: false } },
      'sub-1': { is_internal: true },
    },
  }));
  const interactiveChain = [{ pid: 10, cmd: 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe -c' }];
  assert.equal(isAgyMainSession({ conversationId: 'main-1', cwd: '/repo' }, { appDir, env: {}, ancestry: interactiveChain }), true);
  assert.equal(isAgyMainSession({ conversationId: 'sub-1', cwd: '/repo' }, { appDir, env: {}, ancestry: interactiveChain }), false, 'is_internal subagent excluded');
  assert.equal(isAgyMainSession({ conversationId: 'no-lock', cwd: '/repo' }, { appDir, env: {}, ancestry: interactiveChain }), false, 'missing presence lock excluded');
  assert.equal(isAgyMainSession({ conversationId: 'main-1', cwd: 'C:\\Users\\u\\.gemini\\antigravity-cli\\worktrees\\p\\sub-1' }, { appDir, env: {}, ancestry: interactiveChain }), false, 'subagent worktree excluded');
  assert.equal(isAgyMainSession({ conversationId: 'print-1', cwd: '/repo' }, { appDir, env: {}, ancestry: [{ pid: 11, cmd: 'agy.exe -p "hello"' }] }), false, 'one-shot -p print mode excluded');
  assert.equal(isAgyMainSession({ conversationId: 'main-1', cwd: '/repo' }, { appDir, env: {}, ancestry: [{ pid: 12, cmd: 'agy.exe' }, { pid: 10, cmd: 'agy.exe' }] }), false, 'nested agy inside agy excluded');
  assert.equal(isAgyMainSession({ conversationId: 'main-1', cwd: '/repo' }, { appDir, env: { CLAUDE_CODE_SESSION_ID: 'x' }, ancestry: interactiveChain }), false, 'nested inside Claude excluded');
  assert.equal(agyCallFor('PreInvocation', { conversationId: 'main-1', cwd: '/repo' }, { appDir }).name, 'Refactor Harness');
});

async function ipcRig({ approvalsFromTelegram = true, waitMs = 5000 } = {}) {
  const dir = tmp();
  const claude = new ClaudeAdapter({ token: 't'.repeat(48), queueDir: dir });
  const agy = new AgyAdapter({ queueDir: dir, waitMs });
  claude.local.agy = (p) => agy.handle(p);
  const port = await claude.listen(0);
  const rt = path.join(dir, 'runtime.json');
  fs.writeFileSync(rt, JSON.stringify({ port, token: claude.token }));
  const settingsAsk = path.join(dir, 'settings-ask.json');
  fs.writeFileSync(settingsAsk, JSON.stringify({ toolPermission: 'request-review' }));
  const settingsAlways = path.join(dir, 'settings-always.json');
  fs.writeFileSync(settingsAlways, JSON.stringify({ toolPermission: 'always-proceed' }));
  const telegram = fakeTelegram();
  const ALICE = 42;
  const bridge = new Bridge({
    telegram, adapters: [claude, agy], machine: 'host-a', alertGraceMs: 60000,
    config: { projects: { proj: { chatId: -100 } }, fallbackChatId: -999, allowedUserIds: [ALICE], approvalsFromTelegram, idleCloseMinutes: 30, deleteClosedAfterHours: 24 },
    resolveContext: () => ({ project: 'proj', branch: 'main' }),
  });
  const callHook = (event, input, settingsFile = settingsAsk) => forwardAgyHook(event, input, { runtimeFile: rt, settingsFile });
  const close = async () => { agy.close(); await claude.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, claude, agy, bridge, telegram, rt, settingsAsk, settingsAlways, ALICE, callHook, close };
}

test('IPC parity: Telegram question wait+answer denies ask_question with selected answer; local question relays read-only and resolves on PostToolUse', async () => {
  const r = await ipcRig();
  const resolved = [];
  r.agy.on('question-resolved', (e) => resolved.push(e.ref));
  try {
    // 1. Local turn: ask_question returns {} immediately, relays read-only, and resolves on PostToolUse.
    await r.callHook('PreInvocation', { conversationId: 'q-sess', cwd: '/proj', invocationNum: 1, lastUserInput: 'deploy app' });
    await until(() => r.telegram.sent.some((m) => m.text === '> deploy app'));
    const askTc = { id: 'tc-local', name: 'ask_question', args: { questions: [{ question: 'Target env?', options: ['Staging', 'Prod'], is_multi_select: false }] } };
    const localOut = await r.callHook('PreToolUse', { conversationId: 'q-sess', invocationNum: 1, toolCall: askTc });
    assert.deepEqual(localOut, {}, 'local turn never blocks TUI dialog');
    await until(() => r.telegram.sent.some((m) => /answer it in the terminal/.test(m.text)));
    const readOnlyPost = r.telegram.sent.at(-1);
    assert.equal(readOnlyPost.replyMarkup, undefined);
    await r.callHook('PostToolUse', { conversationId: 'q-sess', invocationNum: 1, toolCall: askTc });
    assert.equal(resolved.length, 1, 'PostToolUse emits question-resolved');
    await until(() => r.telegram.sent.some((m) => m.text === 'answered locally'));

    // 2. Telegram-started turn (delivered via Stop -> remoteTurn, or explicit turnOrigin: 'telegram'):
    // waits for user button tap and returns { decision: 'deny', reason: 'User answered via Telegram:\n...' }.
    const topicId = r.bridge.sessions.get('agy:q-sess').topicId;
    await r.bridge.handleUpdate({ message: { chat: { id: -100 }, from: { id: r.ALICE, username: 'alice' }, text: 'do release', is_topic_message: true, message_thread_id: topicId } });
    const stopOut = await r.callHook('Stop', { conversationId: 'q-sess' });
    assert.equal(stopOut.stopContinue, 'Message from Telegram (alice):\ndo release');
    await r.callHook('PreInvocation', { conversationId: 'q-sess', invocationNum: 1, lastUserInput: stopOut.stopContinue, continuationActive: true });

    const tgAskTc = { id: 'tc-tg', name: 'ask_question', args: { questions: [{ question: 'Which region?', options: ['us-east', 'eu-west'], is_multi_select: false }] } };
    const pendingHook = r.callHook('PreToolUse', { conversationId: 'q-sess', invocationNum: 1, toolCall: tgAskTc });
    await until(() => r.telegram.sent.some((m) => /Which region\?/.test(m.text) && m.replyMarkup));
    assert.equal(r.agy.statusSnapshot('q-sess').state, 'waiting-input');
    const qPost = r.telegram.sent.at(-1);
    assert.deepEqual(qPost.replyMarkup.inline_keyboard.map((row) => row[0].text), ['us-east', 'eu-west']);

    await r.bridge.handleUpdate({
      callback_query: {
        id: 'cb-q', from: { id: r.ALICE, username: 'alice' },
        data: qPost.replyMarkup.inline_keyboard[1][0].callback_data,
        message: { chat: { id: qPost.chatId }, message_id: qPost.message_id, message_thread_id: qPost.threadId, text: qPost.text },
      },
    });
    const answered = await pendingHook;
    assert.deepEqual(answered, { decision: 'deny', reason: 'User answered via Telegram:\nWhich region? -> eu-west' });
    assert.equal(r.agy.statusSnapshot('q-sess').state, 'running');
  } finally { await r.close(); }
});

test('IPC parity: PreToolUse approvals allow/deny in Telegram-started turns and never block local turns or always-proceed', async () => {
  const r = await ipcRig({ approvalsFromTelegram: true });
  try {
    // Local turn with request-review: never blocks.
    await r.callHook('PreInvocation', { conversationId: 'ap-sess', cwd: '/proj', invocationNum: 1, lastUserInput: 'local run' });
    await until(() => r.telegram.sent.some((m) => m.text === '> local run'));
    const cmdTc = { id: 'cmd-1', name: 'run_command', args: { CommandLine: 'rm -rf dist' } };
    assert.deepEqual(await r.callHook('PreToolUse', { conversationId: 'ap-sess', invocationNum: 1, toolCall: cmdTc }, r.settingsAsk), {});

    // Telegram-started turn (`turnOrigin: 'telegram'`) with always-proceed: never blocks.
    assert.deepEqual(await r.callHook('PreToolUse', { conversationId: 'ap-sess', invocationNum: 1, turnOrigin: 'telegram', toolCall: cmdTc }, r.settingsAlways), {});

    // Telegram-started turn with request-review: waits for Approve button -> { decision: 'allow' }.
    const allowHook = r.callHook('PreToolUse', { conversationId: 'ap-sess', invocationNum: 2, turnOrigin: 'telegram', toolCall: cmdTc }, r.settingsAsk);
    await until(() => r.telegram.sent.some((m) => /approval needed/.test(m.text) && m.replyMarkup));
    assert.equal(r.agy.statusSnapshot('ap-sess').state, 'waiting-approval');
    const apPost1 = r.telegram.sent.at(-1);
    await r.bridge.handleUpdate({
      callback_query: {
        id: 'cb-ap-y', from: { id: r.ALICE, username: 'alice' },
        data: apPost1.replyMarkup.inline_keyboard[0][0].callback_data,
        message: { chat: { id: apPost1.chatId }, message_id: apPost1.message_id, message_thread_id: apPost1.threadId, text: apPost1.text },
      },
    });
    assert.deepEqual(await allowHook, { decision: 'allow' });
    assert.equal(r.agy.statusSnapshot('ap-sess').tasks?.[0]?.label, 'rm -rf dist', 'task starts once approved');
    await r.callHook('PostToolUse', { conversationId: 'ap-sess', invocationNum: 2, toolCall: cmdTc }, r.settingsAsk);

    // Telegram-started turn with write_file -> Decline button -> { decision: 'deny', reason }.
    const writeTc = { id: 'w-1', name: 'write_file', args: { Path: '/proj/out.txt' } };
    const denyHook = r.callHook('PreToolUse', { conversationId: 'ap-sess', invocationNum: 3, turnOrigin: 'telegram', toolCall: writeTc }, r.settingsAsk);
    await until(() => r.telegram.sent.filter((m) => m.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('ap:')).length === 2);
    const apPost2 = r.telegram.sent.at(-1);
    await r.bridge.handleUpdate({
      callback_query: {
        id: 'cb-ap-n', from: { id: r.ALICE, username: 'alice' },
        data: apPost2.replyMarkup.inline_keyboard[0][1].callback_data,
        message: { chat: { id: apPost2.chatId }, message_id: apPost2.message_id, message_thread_id: apPost2.threadId, text: apPost2.text },
      },
    });
    assert.deepEqual(await denyHook, { decision: 'deny', reason: 'Denied from Telegram.' });
  } finally { await r.close(); }
});

test('IPC parity: approvalsFromTelegram=false posts notice and releases hook immediately without hanging', async () => {
  const r = await ipcRig({ approvalsFromTelegram: false, waitMs: 60000 });
  try {
    await r.callHook('PreInvocation', { conversationId: 'ap-off', cwd: '/proj', invocationNum: 1, turnOrigin: 'telegram', lastUserInput: 'edit file' });
    const t0 = Date.now();
    const out = await r.callHook('PreToolUse', {
      conversationId: 'ap-off', invocationNum: 1, turnOrigin: 'telegram',
      toolCall: { id: 'e-1', name: 'edit_file', args: { Path: '/proj/a.js' } },
    }, r.settingsAsk);
    assert.deepEqual(out, {});
    assert.ok(Date.now() - t0 < 1500, 'released immediately when Telegram buttons are disabled');
    assert.ok(r.telegram.sent.some((m) => /answer locally or via official remote/.test(m.text)));
  } finally { await r.close(); }
});

test('IPC parity: /interrupt denies PreToolUse, terminates PreInvocation, cancels in-flight waits, and clears once delivered', async () => {
  const r = await ipcRig();
  try {
    await r.callHook('PreInvocation', { conversationId: 'int-sess', cwd: '/proj', invocationNum: 1, lastUserInput: 'long task' });
    await until(() => r.bridge.sessions.get('agy:int-sess')?.topicId != null);
    const topicId = r.bridge.sessions.get('agy:int-sess').topicId;
    const sendInterrupt = () => r.bridge.handleUpdate({
      message: { chat: { id: -100 }, from: { id: r.ALICE, username: 'alice' }, text: '/interrupt', is_topic_message: true, message_thread_id: topicId },
    });

    // 1. /interrupt -> next PreToolUse returns { decision: 'deny', reason: 'Interrupted from Telegram.' } and clears the flag.
    await sendInterrupt();
    await until(() => r.telegram.sent.some((m) => m.text === 'interrupt sent'));
    const preOut = await r.callHook('PreToolUse', { conversationId: 'int-sess', invocationNum: 1, toolCall: { name: 'run_command', args: { CommandLine: 'sleep 10' } } }, r.settingsAlways);
    assert.deepEqual(preOut, { decision: 'deny', reason: 'Interrupted from Telegram.' });
    assert.deepEqual(await r.callHook('PreToolUse', { conversationId: 'int-sess', invocationNum: 1, toolCall: { name: 'run_command', args: { CommandLine: 'echo ok' } } }, r.settingsAlways),
      {}, 'flag cleared once delivered on PreToolUse');

    // 2. /interrupt -> next PreInvocation returns { terminate: true, reason: 'Interrupted from Telegram.' } and clears the flag.
    await sendInterrupt();
    const invOut = await r.callHook('PreInvocation', { conversationId: 'int-sess', invocationNum: 2 });
    assert.deepEqual(invOut, { terminate: true, reason: 'Interrupted from Telegram.' });
    assert.equal(r.agy.statusSnapshot('int-sess').state, 'idle');
    assert.deepEqual(await r.callHook('PreInvocation', { conversationId: 'int-sess', invocationNum: 1, lastUserInput: 'next turn' }),
      {}, 'flag cleared once delivered on PreInvocation');

    // 3. /interrupt while waiting on a Telegram question settles the wait immediately AND still terminates a follow-up PreInvocation.
    const waitHook = r.callHook('PreToolUse', {
      conversationId: 'int-sess', invocationNum: 1, turnOrigin: 'telegram',
      toolCall: { id: 'q-int', name: 'ask_question', args: { questions: [{ question: 'Continue?', options: ['Yes', 'No'] }] } },
    });
    await until(() => r.agy.statusSnapshot('int-sess').state === 'waiting-input');
    await sendInterrupt();
    assert.deepEqual(await waitHook, { decision: 'deny', reason: 'Interrupted from Telegram.' });
    assert.deepEqual(await r.callHook('PreInvocation', { conversationId: 'int-sess', invocationNum: 2 }),
      { terminate: true, reason: 'Interrupted from Telegram.' });
    assert.deepEqual(await r.callHook('PreInvocation', { conversationId: 'int-sess', invocationNum: 3 }), {}, 'cleared after PreInvocation');
  } finally { await r.close(); }
});

test('end to end over the Claude IPC: wrong token fails open to {}', async () => {
  const claude = new ClaudeAdapter({ token: 't'.repeat(48) });
  const agy = new AgyAdapter();
  claude.local.agy = (p) => agy.handle(p);
  const port = await claude.listen(0);
  const rt = path.join(tmp(), 'runtime.json');
  fs.writeFileSync(rt, JSON.stringify({ port, token: 'x'.repeat(48) }));
  const ups = [];
  agy.on('up', (e) => ups.push(e.id));
  try {
    assert.deepEqual(await forwardAgyHook('SessionStart', { conversationId: 'other' }, { runtimeFile: rt }), {});
    assert.deepEqual(ups, []);
  } finally { agy.close(); await claude.close(); }
});
