import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Bridge, runningDaemonPid } from './daemon.mjs';

function fakeTelegram() {
  const sent = [], edits = [], topics = [], answers = [];
  let nextTopic = 100, nextMsg = 1;
  return {
    sent, edits, topics, answers,
    createForumTopic: async (chatId, name) => { topics.push([chatId, name]); return { message_thread_id: nextTopic++ }; },
    sendMessage: async (chatId, text, opts = {}) => { sent.push({ chatId, text, ...opts }); return [{ message_id: nextMsg++ }]; },
    editMessageText: async (chatId, id, text) => { edits.push({ chatId, id, text }); },
    answerCallbackQuery: async (id, text) => { answers.push(text); },
  };
}

function fakeCodex() {
  const c = new EventEmitter();
  c.injected = []; c.answered = [];
  c.inject = async (id, text) => { c.injected.push([id, text]); return 'started'; };
  c.interrupt = async () => true;
  c.status = () => 'idle';
  c.answerApproval = (key, yes) => { c.answered.push([key, yes]); return true; };
  return c;
}

function fakeHub() {
  const h = new EventEmitter();
  h.sessions = new Map();
  h.delivered = []; h.verdicts = [];
  h.deliver = (id, text, user) => { h.delivered.push([id, text, user]); return true; };
  h.verdict = (id, req, allow) => { h.verdicts.push([id, req, allow]); return true; };
  return h;
}

const ALICE = 42, MALLORY = 666;
const baseConfig = { projects: { 'proj': { chatId: -100 } }, fallbackChatId: -999, allowedUserIds: [ALICE], approvalsFromTelegram: false };

function make(config = {}) {
  const telegram = fakeTelegram(), codex = fakeCodex(), hub = fakeHub();
  const bridge = new Bridge({
    telegram, codex, hub, machine: 'WS1', config: { ...baseConfig, ...config },
    resolveContext: (cwd, h) => ({ project: cwd === '/proj' ? 'proj' : 'other', branch: h.branch ?? 'main' }),
  });
  return { bridge, telegram, codex, hub };
}

const flush = () => new Promise((r) => setImmediate(r));
const msg = (from, text, thread = 100, chat = -100) => ({ message: { chat: { id: chat }, from: { id: from, username: 'u' }, text, is_topic_message: true, message_thread_id: thread } });

test('session-up creates <machine>/<agent>/<branch> topic in the project group, fallback otherwise', async () => {
  const { bridge, telegram } = make();
  await bridge.sessionUp('codex', 't1', { cwd: '/proj', branch: 'feat/x' });
  await bridge.sessionUp('claude', 's1', { cwd: '/elsewhere', branch: 'main' });
  await bridge.sessionUp('codex', 't2', { cwd: '/proj', branch: 'feat/x' });
  assert.deepEqual(telegram.topics, [[-100, 'WS1/codex/feat/x'], [-999, 'WS1/claude/main'], [-100, 'WS1/codex/feat/x #2']]);
  assert.equal(telegram.sent[0].threadId, 100);
});

test('topic cache reuses a Topic across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const topicCacheFile = path.join(dir, 'topics.json');
  try {
    const a = make(); a.bridge.topicCacheFile = topicCacheFile;
    await a.bridge.sessionUp('codex', 't1', { cwd: '/proj', branch: 'main' });
    const b = make();
    const bridge2 = new Bridge({ ...b, telegram: b.telegram, machine: 'WS1', config: baseConfig, topicCacheFile,
      resolveContext: () => ({ project: 'proj', branch: 'main' }) });
    const s = await bridge2.sessionUp('codex', 't9', { cwd: '/proj' });
    assert.equal(s.topicId, 100);
    assert.deepEqual(b.telegram.topics, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('text from an allowlisted user is injected into the topic session; others are dropped', async () => {
  const { bridge, codex, hub, telegram } = make();
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });       // topic 100
  await bridge.sessionUp('claude', 's1', { cwd: '/proj', branch: 'dev' });  // topic 101
  const before = telegram.sent.length;
  await bridge.handleUpdate(msg(MALLORY, 'rm -rf /'));
  assert.deepEqual(codex.injected, []);
  assert.equal(telegram.sent.length, before, 'no reply to strangers');
  await bridge.handleUpdate(msg(ALICE, 'fix the test', 100));
  await bridge.handleUpdate(msg(ALICE, 'and docs', 101));
  assert.deepEqual(codex.injected, [['t1', 'fix the test']]);
  assert.deepEqual(hub.delivered, [['s1', 'and docs', 'u']]);
});

test('prompts typed in the TUI are mirrored; ones injected from the Topic are not echoed', async () => {
  const { bridge, codex, telegram } = make();
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  codex.emit('prompt', { threadId: 't1', text: 'refactor the parser' }); await flush();
  assert.equal(telegram.sent.at(-1).text, '> refactor the parser');
  await bridge.handleUpdate(msg(ALICE, 'from phone', 100));
  const before = telegram.sent.length;
  codex.emit('prompt', { threadId: 't1', text: 'from phone' }); await flush();
  assert.equal(telegram.sent.length, before, 'own injection not echoed');
  codex.emit('prompt', { threadId: 't1', text: 'from phone' }); await flush();
  assert.equal(telegram.sent.at(-1).text, '> from phone', 'echo suppressed only once');
});

test('a codex backlog lands in the new Topic, after the session-up notice, in order', async () => {
  const { codex, telegram } = make();
  codex.emit('session-up', { threadId: 't9', cwd: '/proj', backlog: [
    { kind: 'prompt', text: 'hi' }, { kind: 'final', text: 'Hello!', status: 'completed' }] });
  await flush(); await flush();
  const texts = telegram.sent.map((s) => s.text);
  const up = texts.findIndex((t) => t.startsWith('session up'));
  assert.deepEqual(texts.slice(up), [texts[up], '> hi', 'Hello!']);
  assert.ok(telegram.sent.slice(up).every((s) => s.threadId === telegram.sent[up].threadId), 'all in the same Topic');
});

test('/status and /interrupt commands', async () => {
  const { bridge, telegram } = make();
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  await bridge.sessionUp('claude', 's1', { cwd: '/proj', branch: 'dev' });
  await bridge.handleUpdate(msg(ALICE, '/status@my_bot', 100));
  assert.match(telegram.sent.at(-1).text, /WS1\/codex\/main: idle/);
  await bridge.handleUpdate(msg(ALICE, '/interrupt', 100));
  assert.equal(telegram.sent.at(-1).text, 'interrupt sent');
  await bridge.handleUpdate(msg(ALICE, '/interrupt', 101));
  assert.match(telegram.sent.at(-1).text, /Codex-only/);
});

test('progress lines collapse into one edited message; final is a new message', async () => {
  let t = 0;
  const { bridge, telegram, codex } = make();
  bridge.now = () => t;
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  t = 10000; codex.emit('progress', { threadId: 't1', text: '$ ls' }); await flush();
  t = 20000; codex.emit('progress', { threadId: 't1', text: '$ npm test' }); await flush();
  const progressMsgs = telegram.sent.filter((s) => s.text.startsWith('working'));
  assert.equal(progressMsgs.length, 1);
  assert.match(telegram.edits.at(-1).text, /\$ ls\n\$ npm test/);
  codex.emit('final', { threadId: 't1', text: 'All green', status: 'completed' }); await flush();
  assert.equal(telegram.sent.at(-1).text, 'All green');
  codex.emit('final', { threadId: 't1', text: '', status: 'interrupted' }); await flush();
  assert.match(telegram.sent.at(-1).text, /\[interrupted\]/);
});

test('claude reply tool output lands in its topic', async () => {
  const { bridge, telegram, hub } = make();
  await bridge.sessionUp('claude', 's1', { cwd: '/proj' });
  hub.emit('reply', { sessionId: 's1', text: 'done: 3 files' }); await flush();
  assert.deepEqual([telegram.sent.at(-1).text, telegram.sent.at(-1).threadId], ['done: 3 files', 100]);
});

test('approvals: notice only by default; no buttons, callbacks ignored', async () => {
  const { bridge, telegram, codex } = make();
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  codex.emit('approval', { threadId: 't1', key: 'c7', summary: '$ rm x', answerable: true }); await flush();
  const notice = telegram.sent.at(-1);
  assert.match(notice.text, /approval needed on WS1, answer locally or via official remote/);
  assert.equal(notice.replyMarkup, undefined);
  await bridge.handleUpdate({ callback_query: { id: 'q', data: 'ap:1:y', from: { id: ALICE } } });
  assert.deepEqual(codex.answered, []);
});

test('approvals opt-in: buttons, allowlisted user answers, stranger cannot', async () => {
  const { bridge, telegram, codex, hub } = make({ approvalsFromTelegram: true });
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  await bridge.sessionUp('claude', 's1', { cwd: '/proj', branch: 'dev' });
  codex.emit('approval', { threadId: 't1', key: 'c7', summary: '$ rm x', answerable: true }); await flush();
  const kb = telegram.sent.at(-1).replyMarkup.inline_keyboard[0];
  assert.deepEqual(kb.map((b) => b.callback_data), ['ap:1:y', 'ap:1:n']);
  await bridge.handleUpdate({ callback_query: { id: 'q1', data: 'ap:1:y', from: { id: MALLORY } } });
  assert.deepEqual(codex.answered, []);
  assert.equal(telegram.answers.at(-1), 'not allowed');
  await bridge.handleUpdate({ callback_query: { id: 'q2', data: 'ap:1:n', from: { id: ALICE } } });
  assert.deepEqual(codex.answered, [['c7', false]]);
  await bridge.handleUpdate({ callback_query: { id: 'q3', data: 'ap:1:y', from: { id: ALICE } } });
  assert.equal(telegram.answers.at(-1), 'already resolved');

  hub.emit('permission', { sessionId: 's1', request_id: 'abcde', tool_name: 'Bash', description: 'ls' }); await flush();
  await bridge.handleUpdate({ callback_query: { id: 'q4', data: 'ap:2:y', from: { id: ALICE } } });
  assert.deepEqual(hub.verdicts, [['s1', 'abcde', true]]);

  codex.emit('approval', { threadId: 't1', key: 'c9', summary: 'perm', answerable: false }); await flush();
  assert.equal(telegram.sent.at(-1).replyMarkup, undefined, 'unanswerable shapes never get buttons');
});

test('session-down posts an end notice and forgets the session', async () => {
  const { bridge, telegram, codex } = make();
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  codex.emit('session-down', { threadId: 't1' }); await flush();
  assert.match(telegram.sent.at(-1).text, /session ended/);
  await bridge.handleUpdate(msg(ALICE, 'hello', 100));
  assert.deepEqual(codex.injected, []);
});

test('runningDaemonPid: live pid detected, dead or own pid ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const f = path.join(dir, 'runtime.json');
  try {
    assert.equal(runningDaemonPid(f), null);
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid }));
    assert.equal(runningDaemonPid(f), null);
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid }));
    assert.equal(runningDaemonPid(f), process.ppid);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
