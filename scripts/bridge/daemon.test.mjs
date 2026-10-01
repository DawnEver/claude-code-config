import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Bridge, runningDaemonPid } from './daemon.mjs';

function fakeTelegram() {
  const sent = [], edits = [], topics = [], answers = [], closed = [], reopened = [];
  let nextTopic = 100, nextMsg = 1;
  return {
    sent, edits, topics, answers, closed, reopened,
    closeForumTopic: async (chatId, threadId) => { closed.push([chatId, threadId]); return true; },
    reopenForumTopic: async (chatId, threadId) => { reopened.push([chatId, threadId]); return true; },
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
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
};
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
    const s = await bridge2.sessionUp('codex', 't1', { cwd: '/proj', preexisting: true });
    assert.equal(s.topicId, 100);
    assert.deepEqual(b.telegram.topics, []);
    assert.deepEqual(b.telegram.sent, [], 're-attached silently, no second "session up"');
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

test('a session loaded before the bridge started opens its Topic only on first activity', async () => {
  const { bridge, codex, telegram } = make();
  await bridge.sessionUp('codex', 'old', { cwd: '/proj', preexisting: true });
  bridge.sessionDown('codex:old');
  await bridge.sessionUp('codex', 'idle', { cwd: '/proj', preexisting: true });
  assert.deepEqual(telegram.topics, [], 'idle leftovers stay invisible');
  assert.deepEqual(telegram.sent, [], 'not even a "session ended"');
  codex.emit('prompt', { threadId: 'idle', text: 'back again' }); await flush();
  assert.equal(telegram.topics.length, 1);
  assert.deepEqual(telegram.sent.map((s) => s.text), ['session up: WS1/codex/main (proj)', '> back again']);
});

test('an idle leftover on the same branch does not push a new session to "#2"', async () => {
  const { bridge, telegram } = make();
  await bridge.sessionUp('codex', 'idle', { cwd: '/proj', preexisting: true });
  await bridge.sessionUp('codex', 'fresh', { cwd: '/proj' });
  assert.deepEqual(telegram.topics.map((t) => t[1]), ['WS1/codex/main']);
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

test('session-down posts the end notice, then closes the Topic', async () => {
  const { bridge, telegram, hub } = make();
  await bridge.sessionUp('claude', 's1', { cwd: '/proj' });
  hub.emit('session-down', { sessionId: 's1' });
  await until(() => telegram.closed.length);
  assert.equal(telegram.sent.at(-1).text, 'session ended: WS1/claude/main');
  assert.deepEqual(telegram.closed, [[-100, 100]]);
});

test('a cached Topic is reopened once before the first post after re-attach', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const topicCacheFile = path.join(dir, 'topics.json');
  try {
    fs.writeFileSync(topicCacheFile, JSON.stringify({ '-100|codex:t1': 55 }));
    const telegram = fakeTelegram();
    telegram.reopenForumTopic = async (c, t) => { telegram.reopened.push([c, t]); throw new Error('telegram reopenForumTopic: Bad Request: TOPIC_NOT_MODIFIED'); };
    const codex = fakeCodex();
    const bridge = new Bridge({ telegram, codex, machine: 'WS1', config: baseConfig, topicCacheFile,
      resolveContext: () => ({ project: 'proj', branch: 'main' }) });
    await bridge.sessionUp('codex', 't1', { cwd: '/proj', preexisting: true });
    assert.deepEqual(telegram.reopened, [], 'silent re-attach does not touch Telegram');
    codex.emit('prompt', { threadId: 't1', text: 'again' });
    codex.emit('final', { threadId: 't1', text: 'ok', status: 'completed' });
    await until(() => telegram.sent.length === 2);
    assert.deepEqual(telegram.reopened, [[-100, 55]]);
    assert.deepEqual(telegram.sent.map((s) => [s.text, s.threadId]), [['> again', 55], ['ok', 55]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('claude mirror: prompt and final routed by claudePid, Telegram injections not echoed, reply not doubled', async () => {
  const { bridge, telegram, hub } = make();
  hub.emit('session-up', { sessionId: 'uuid-1', cwd: '/proj', branch: 'main', claudePid: 4242 });
  await until(() => telegram.sent.length === 1);
  // After /clear the hook reports a new session id but the same claude pid.
  hub.emit('mirror', { claudePid: 4242, sessionId: 'uuid-2', kind: 'prompt', text: 'hi' });
  hub.emit('mirror', { claudePid: 4242, sessionId: 'uuid-2', kind: 'final', text: 'Hello!' });
  await until(() => telegram.sent.length === 3);
  assert.deepEqual(telegram.sent.slice(1).map((s) => [s.text, s.threadId]), [['> hi', 100], ['Hello!', 100]]);

  await bridge.handleUpdate(msg(ALICE, 'from phone', 100));
  hub.emit('mirror', { claudePid: 4242, kind: 'prompt', text: 'from phone' });
  hub.emit('reply', { sessionId: 'uuid-1', text: 'done: 3 files' });
  hub.emit('mirror', { claudePid: 4242, kind: 'final', text: 'done: 3 files\n' });
  hub.emit('mirror', { claudePid: 4242, kind: 'final', text: '   ' });
  await flush(); await flush(); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(telegram.sent.slice(3).map((s) => s.text), ['done: 3 files'], 'no echo, no double post, no empty final');
});

test('a mirror that beats the channel registration is held until the session is up', async () => {
  const { telegram, hub } = make();
  hub.emit('mirror', { claudePid: 7, sessionId: 'u', kind: 'prompt', text: 'early' });
  hub.emit('session-up', { sessionId: 'u', cwd: '/proj', branch: 'main', claudePid: 7 });
  await until(() => telegram.sent.length === 2);
  assert.deepEqual(telegram.sent.map((s) => s.text), ['session up: WS1/claude/main (proj)', '> early']);
});

test('a new Topic is unpinned after its first post; a failure is logged once and ignored', async () => {
  const { bridge, telegram } = make();
  const logs = [];
  bridge.log = (m) => logs.push(m);
  const unpinned = [];
  telegram.unpinAllForumTopicMessages = async (c, t) => { unpinned.push([c, t, telegram.sent.length]); throw new Error('not enough rights'); };
  await bridge.sessionUp('codex', 't1', { cwd: '/proj' });
  await bridge.sessionUp('codex', 't2', { cwd: '/proj' });
  assert.deepEqual(unpinned, [[-100, 100, 1], [-100, 101, 2]], 'after the session-up post');
  assert.equal(logs.filter((l) => /unpin/.test(l)).length, 1);
});

test('closing records closedAt; reopening clears it; sweep deletes only own Topics closed > N hours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const topicCacheFile = path.join(dir, 'topics.json');
  const H = 3600000;
  try {
    // legacy number entry (never closed by us) and a foreign-looking entry must survive.
    fs.writeFileSync(topicCacheFile, JSON.stringify({ '-100|codex:legacy': 9 }));
    let t = 0;
    const telegram = fakeTelegram();
    const deleted = [];
    let rightsOk = false;
    telegram.deleteForumTopic = async (c, id) => {
      if (!rightsOk) throw new Error('telegram deleteForumTopic: Bad Request: not enough rights');
      deleted.push([c, id]); return true;
    };
    const logs = [];
    const bridge = new Bridge({ telegram, codex: fakeCodex(), machine: 'WS1', config: baseConfig, topicCacheFile,
      resolveContext: () => ({ project: 'proj', branch: 'main' }), now: () => t, log: (m) => logs.push(m) });
    await bridge.sessionUp('codex', 'a', { cwd: '/proj' });   // topic 100
    await bridge.sessionUp('codex', 'b', { cwd: '/proj' });   // topic 101
    bridge.sessionDown('codex:a'); bridge.sessionDown('codex:b');
    await until(() => telegram.closed.length === 2);
    const cache = () => JSON.parse(fs.readFileSync(topicCacheFile, 'utf8'));
    assert.deepEqual(cache()['-100|codex:a'], { topicId: 100, closedAt: 0 });

    t = 1 * H;   // b comes back: reopen clears closedAt
    await bridge.sessionUp('codex', 'b', { cwd: '/proj' });
    await bridge.prompt('codex:b', 'again');
    assert.deepEqual(cache()['-100|codex:b'], { topicId: 101 });

    t = 23 * H; await bridge.sweepClosedTopics();
    assert.deepEqual(deleted, [], 'not old enough');
    t = 25 * H; await bridge.sweepClosedTopics(); await bridge.sweepClosedTopics();
    assert.equal(logs.filter((l) => /deleteForumTopic/.test(l)).length, 1, 'rights error logged once');
    assert.ok(cache()['-100|codex:a'], 'kept for retry');
    rightsOk = true; await bridge.sweepClosedTopics();
    assert.deepEqual(deleted, [[-100, 100]]);
    assert.deepEqual(Object.keys(cache()).sort(), ['-100|codex:b', '-100|codex:legacy']);

    bridge.config = { ...baseConfig, deleteClosedAfterHours: 0 };
    bridge.sessionDown('codex:b'); await until(() => telegram.closed.length === 3);
    t = 1000 * H; await bridge.sweepClosedTopics();
    assert.deepEqual(deleted, [[-100, 100]], '0 = never');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
