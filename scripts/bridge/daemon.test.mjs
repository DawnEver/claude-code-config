import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Bridge, runningDaemonPid } from './daemon.mjs';

const M = 60000, H = 60 * M;
const HOSTS = ['codex', 'claude'];

function fakeTelegram() {
  const t = { sent: [], edits: [], topics: [], answers: [], closed: [], reopened: [], deleted: [], unpinned: [] };
  let nextTopic = 100, nextMsg = 1;
  Object.assign(t, {
    createForumTopic: async (chatId, name) => { t.topics.push([chatId, name]); return { message_thread_id: nextTopic++ }; },
    sendMessage: async (chatId, text, opts = {}) => { t.sent.push({ chatId, text, ...opts }); return [{ message_id: nextMsg++ }]; },
    editMessageText: async (chatId, id, text) => { t.edits.push({ chatId, id, text }); },
    answerCallbackQuery: async (id, text) => { t.answers.push(text); },
    closeForumTopic: async (c, id) => { t.closed.push([c, id]); return true; },
    reopenForumTopic: async (c, id) => { t.reopened.push([c, id]); return true; },
    deleteForumTopic: async (c, id) => { t.deleted.push([c, id]); return true; },
    unpinAllForumTopicMessages: async (c, id) => { t.unpinned.push([c, id]); return true; },
  });
  return t;
}

function fakeHost(agent, { interrupt = agent === 'codex' } = {}) {
  const h = new EventEmitter();
  h.agent = agent;
  h.injected = []; h.answered = [];
  h.inject = async (id, text, user) => { h.injected.push([id, text, user]); };
  h.status = () => 'idle';
  h.answerApproval = (ref, yes, id) => { h.answered.push([ref, yes, id]); return true; };
  if (interrupt) h.interrupt = async () => true;
  return h;
}

const ALICE = 42, MALLORY = 666;
const baseConfig = { projects: { proj: { chatId: -100 } }, fallbackChatId: -999, allowedUserIds: [ALICE],
  approvalsFromTelegram: false, idleCloseMinutes: 30, deleteClosedAfterHours: 24 };

function make({ config = {}, topicCacheFile = null } = {}) {
  const telegram = fakeTelegram();
  const hosts = { codex: fakeHost('codex'), claude: fakeHost('claude') };
  const logs = [];
  let t = 0;
  const bridge = new Bridge({
    telegram, adapters: Object.values(hosts), machine: 'host-a', config: { ...baseConfig, ...config }, topicCacheFile,
    resolveContext: (cwd, h) => ({ project: cwd === '/proj' ? 'proj' : 'other', branch: h.branch ?? 'main' }),
    log: (m) => logs.push(m), now: () => t,
  });
  return { bridge, telegram, hosts, logs, at: (v) => { t = v; } };
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const msg = (from, text, thread = 100, chat = -100) => ({ message: { chat: { id: chat }, from: { id: from, username: 'u' }, text, is_topic_message: true, message_thread_id: thread } });
const up = (r, agent, id, extra = {}) => r.bridge.sessionUp(agent, { id, cwd: '/proj', ...extra });
const texts = (t) => t.sent.map((s) => s.text);

test('topics: <machine>/<agent>/<branch> in the project group, fallback otherwise, numbered per group', async () => {
  const r = make();
  await up(r, 'codex', 't1', { branch: 'feat/x' });
  await r.bridge.sessionUp('claude', { id: 's1', cwd: '/elsewhere' });
  await up(r, 'codex', 't2', { branch: 'feat/x' });
  assert.deepEqual(r.telegram.topics, [[-100, 'host-a/codex/feat/x'], [-999, 'host-a/claude/main'], [-100, 'host-a/codex/feat/x #2']]);
  assert.deepEqual(r.telegram.unpinned, [[-100, 100], [-999, 101], [-100, 102]], 'auto-pinned first message is unpinned');
});

for (const agent of HOSTS) {
  test(`${agent}: the whole lifecycle — up, mirror, idle close, reopen same Topic, end, delete`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
    const topicCacheFile = path.join(dir, 'topics.json');
    const cache = () => JSON.parse(fs.readFileSync(topicCacheFile, 'utf8'));
    try {
      const r = make({ topicCacheFile });
      const host = r.hosts[agent];
      await up(r, agent, 'x');
      host.emit('prompt', { id: 'x', text: 'hi' });
      host.emit('final', { id: 'x', text: 'Hello!' });
      await until(() => r.telegram.sent.length === 3);
      assert.deepEqual(texts(r.telegram), [`session up: host-a/${agent}/main (proj)`, '> hi', 'Hello!']);

      r.at(29 * M); await r.bridge.closeIdle();
      assert.deepEqual(r.telegram.closed, [], '29m: still open');
      r.at(30 * M); await r.bridge.closeIdle(); await r.bridge.closeIdle();
      assert.deepEqual(r.telegram.closed, [[-100, 100]], 'closed once, quietly');
      assert.equal(r.telegram.sent.length, 3, 'no message on idle close');
      assert.equal(cache()[`-100|${agent}:x`].closedAt, 30 * M);

      r.at(30 * M + 25 * H); await r.bridge.sweepClosedTopics();
      assert.deepEqual(r.telegram.deleted, [], 'never deleted while registered');

      await r.bridge.handleUpdate(msg(ALICE, 'wake up'));
      await until(() => r.telegram.reopened.length === 1);
      assert.deepEqual(r.telegram.reopened, [[-100, 100]], 'same Topic');
      assert.deepEqual(host.injected, [['x', 'wake up', 'u']]);
      assert.equal(cache()[`-100|${agent}:x`].closedAt, undefined, 'closedAt cleared');
      host.emit('prompt', { id: 'x', text: 'wake up' });   // the echo of the inject
      host.emit('final', { id: 'x', text: 'awake' });
      await until(() => r.telegram.sent.length === 4);
      await settle();
      assert.deepEqual(texts(r.telegram).slice(3), ['awake'], 'inject not echoed');
      assert.equal(r.telegram.topics.length, 1);

      r.at(40 * H);
      host.emit('down', { id: 'x' });
      await until(() => r.telegram.closed.length === 2);
      assert.equal(texts(r.telegram).at(-1), `session ended: host-a/${agent}/main`);
      r.at(40 * H + 23 * H); await r.bridge.sweepClosedTopics();
      assert.deepEqual(r.telegram.deleted, []);
      r.at(40 * H + 24 * H); await r.bridge.sweepClosedTopics();
      assert.deepEqual(r.telegram.deleted, [[-100, 100]]);
      assert.deepEqual(cache(), {});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${agent}: a restarted bridge re-attaches to the cached Topic; a closed one is reopened on resume`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
    const topicCacheFile = path.join(dir, 'topics.json');
    try {
      const a = make({ topicCacheFile });
      await up(a, agent, 'x');
      a.hosts[agent].emit('down', { id: 'x' });
      await until(() => a.telegram.closed.length === 1);
      const b = make({ topicCacheFile });
      await up(b, agent, 'x');
      b.hosts[agent].emit('final', { id: 'x', text: 'back' });
      await until(() => b.telegram.sent.length === 1);
      assert.deepEqual(b.telegram.topics, [], 'no new Topic');
      assert.deepEqual(b.telegram.reopened, [[-100, 100]]);
      assert.deepEqual([b.telegram.sent[0].text, b.telegram.sent[0].threadId], ['back', 100]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${agent}: live events during bring-up wait for the backlog, minus turns it already had`, async () => {
    const r = make();
    let open;
    r.telegram.createForumTopic = () => new Promise((res) => { open = () => res({ message_thread_id: 100 }); });
    const host = r.hosts[agent];
    host.emit('up', { id: 'x', cwd: '/proj', preexisting: false, backlog: [{ kind: 'prompt', text: 'hi', turnId: 'T1' }] });
    host.emit('prompt', { id: 'x', turnId: 'T1', text: 'hi' });
    host.emit('final', { id: 'x', turnId: 'T1', text: 'Hello!' });
    await until(() => open);
    open();
    await until(() => r.telegram.sent.length === 3);
    await settle();
    assert.deepEqual(texts(r.telegram), [`session up: host-a/${agent}/main (proj)`, '> hi', 'Hello!']);
  });

  test(`${agent}: a leftover gets no Topic until activity`, async () => {
    const r = make();
    await up(r, agent, 'old', { preexisting: true });
    r.at(1000 * M); await r.bridge.closeIdle();
    r.hosts[agent].emit('down', { id: 'old' });
    await settle();
    assert.deepEqual([r.telegram.topics, r.telegram.sent, r.telegram.closed], [[], [], []]);
    await up(r, agent, 'idle', { preexisting: true });
    r.hosts[agent].emit('prompt', { id: 'idle', text: 'back again' });
    await until(() => r.telegram.sent.length === 2);
    assert.deepEqual(texts(r.telegram), [`session up: host-a/${agent}/main (proj)`, '> back again']);
  });

  test(`${agent}: approvals are notices by default; opt-in buttons honour only the allowlist`, async () => {
    const off = make();
    await up(off, agent, 'x');
    off.hosts[agent].emit('approval', { id: 'x', ref: 'r1', summary: '$ rm x', answerable: true });
    await until(() => off.telegram.sent.length === 2);
    assert.match(texts(off.telegram)[1], /answer locally or via official remote/);
    await off.bridge.handleUpdate({ callback_query: { id: 'q', data: 'ap:1:y', from: { id: ALICE } } });
    assert.deepEqual(off.hosts[agent].answered, []);

    const on = make({ config: { approvalsFromTelegram: true } });
    await up(on, agent, 'x');
    on.hosts[agent].emit('approval', { id: 'x', ref: 'r1', summary: '$ rm x', answerable: true });
    await until(() => on.telegram.sent.length === 2);
    assert.deepEqual(on.telegram.sent[1].replyMarkup.inline_keyboard[0].map((b) => b.callback_data), ['ap:1:y', 'ap:1:n']);
    await on.bridge.handleUpdate({ callback_query: { id: 'q1', data: 'ap:1:y', from: { id: MALLORY } } });
    assert.equal(on.telegram.answers.at(-1), 'not allowed');
    await on.bridge.handleUpdate({ callback_query: { id: 'q2', data: 'ap:1:n', from: { id: ALICE } } });
    assert.deepEqual(on.hosts[agent].answered, [['r1', false, 'x']]);
    await on.bridge.handleUpdate({ callback_query: { id: 'q3', data: 'ap:1:y', from: { id: ALICE } } });
    assert.equal(on.telegram.answers.at(-1), 'already resolved');
    on.hosts[agent].emit('approval', { id: 'x', ref: 'r2', summary: 'perm', answerable: false });
    await until(() => on.telegram.sent.length === 3);
    assert.equal(on.telegram.sent[2].replyMarkup, undefined, 'unanswerable kinds never get buttons');
  });

  test(`${agent}: only what needs the human alerts them; the rest is silent`, async () => {
    const r = make();
    await up(r, agent, 'x');
    r.hosts[agent].emit('final', { id: 'x', text: 'done' });
    r.hosts[agent].emit('approval', { id: 'x', ref: 'r1', summary: '$ rm x', answerable: true });
    r.hosts[agent].emit('final', { id: 'x', text: 'boom', status: 'failed' });
    await until(() => r.telegram.sent.length === 4);
    assert.deepEqual(r.telegram.sent.slice(1).map((m) => m.alert ?? null), [null, [ALICE], [ALICE]]);
  });
}

test('strangers are dropped; /status, /interrupt go through the host interface', async () => {
  const r = make();
  await up(r, 'codex', 't1');                         // topic 100
  await up(r, 'claude', 's1', { branch: 'dev' });     // topic 101
  const before = r.telegram.sent.length;
  await r.bridge.handleUpdate(msg(MALLORY, 'rm -rf /'));
  assert.deepEqual(r.hosts.codex.injected, []);
  assert.equal(r.telegram.sent.length, before);
  await r.bridge.handleUpdate(msg(ALICE, '/status@my_bot', 100));
  await until(() => /host-a\/codex\/main: idle/.test(texts(r.telegram).at(-1)));
  await r.bridge.handleUpdate(msg(ALICE, '/interrupt', 100));
  await until(() => texts(r.telegram).at(-1) === 'interrupt sent');
  await r.bridge.handleUpdate(msg(ALICE, '/interrupt', 101));
  await until(() => /not available for claude/.test(texts(r.telegram).at(-1)));
});

test('an inject that fails is reported in the Topic', async () => {
  const r = make();
  r.hosts.claude.inject = async () => { throw new Error('channel disconnected'); };
  await up(r, 'claude', 's1');
  await r.bridge.handleUpdate(msg(ALICE, 'hello'));
  await until(() => texts(r.telegram).at(-1) === 'inject failed: channel disconnected');
});

test('an injected prompt that never echoes back is forgotten after 10 minutes', async () => {
  const r = make();
  await up(r, 'claude', 's1');
  await r.bridge.handleUpdate(msg(ALICE, 'yes'));
  r.at(11 * M);
  r.hosts.claude.emit('prompt', { id: 's1', text: 'yes' });
  await until(() => texts(r.telegram).at(-1) === '> yes');
});

test('progress lines collapse into one edited message; final is a new message', async () => {
  const r = make();
  await up(r, 'codex', 't1');
  r.at(10000); r.hosts.codex.emit('progress', { id: 't1', text: '$ ls' });
  await until(() => r.telegram.sent.length === 2);
  r.at(20000); r.hosts.codex.emit('progress', { id: 't1', text: '$ npm test' });
  await until(() => r.telegram.edits.length === 1);
  assert.match(r.telegram.edits[0].text, /\$ ls\n\$ npm test/);
  r.hosts.codex.emit('final', { id: 't1', text: 'All green', status: 'completed' });
  r.hosts.codex.emit('final', { id: 't1', text: '', status: 'interrupted' });
  await until(() => r.telegram.sent.length === 4);
  assert.deepEqual(texts(r.telegram).slice(2), ['All green', '[interrupted] (turn interrupted, no message)']);
});

test('Telegram drift: a Topic closed by hand is reopened, a deleted one recreated, then the post is resent', async () => {
  const r = make();
  await up(r, 'codex', 't1');
  const send = r.telegram.sendMessage;
  let fail = 'Bad Request: TOPIC_CLOSED';
  r.telegram.sendMessage = async (...a) => { if (fail) { const m = fail; fail = null; throw new Error(m); } return send(...a); };
  r.hosts.codex.emit('final', { id: 't1', text: 'one' });
  await until(() => texts(r.telegram).at(-1) === 'one');
  assert.deepEqual(r.telegram.reopened, [[-100, 100]]);
  fail = 'Bad Request: message thread not found';
  r.hosts.codex.emit('final', { id: 't1', text: 'two' });
  await until(() => texts(r.telegram).at(-1) === 'two');
  assert.equal(r.telegram.sent.at(-1).threadId, 101, 'posted in the recreated Topic');
});

test('sweep: rights errors logged once per distinct message, entry kept; 0 = never; untouched without closedAt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const topicCacheFile = path.join(dir, 'topics.json');
  try {
    fs.writeFileSync(topicCacheFile, JSON.stringify({
      '-100|codex:a': { topicId: 1, title: 'a', closedAt: 0 },
      '-100|codex:open': { topicId: 2, title: 'b' },
    }));
    const r = make({ topicCacheFile });
    let err = 'not enough rights';
    r.telegram.deleteForumTopic = async (c, id) => { if (err) throw new Error(err); r.telegram.deleted.push(id); return true; };
    r.at(25 * H);
    await r.bridge.sweepClosedTopics(); await r.bridge.sweepClosedTopics();
    err = 'fetch failed'; await r.bridge.sweepClosedTopics();
    assert.equal(r.logs.filter((l) => l.startsWith('deleteForumTopic')).length, 2);
    err = null; await r.bridge.sweepClosedTopics();
    assert.deepEqual(r.telegram.deleted, [1]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(topicCacheFile, 'utf8'))), ['-100|codex:open']);
    const never = make({ topicCacheFile, config: { deleteClosedAfterHours: 0 } });
    assert.equal(await never.bridge.sweepClosedTopics(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a re-attach during an in-flight delete leaves the session without the deleted Topic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const topicCacheFile = path.join(dir, 'topics.json');
  try {
    fs.writeFileSync(topicCacheFile, JSON.stringify({ '-100|claude:s1': { topicId: 55, title: 't', closedAt: 0 } }));
    const r = make({ topicCacheFile });
    let release;
    r.telegram.deleteForumTopic = () => new Promise((res) => { release = res; });
    r.at(25 * H);
    const sweeping = r.bridge.sweepClosedTopics();
    await until(() => release);
    await up(r, 'claude', 's1', { preexisting: true });
    release(true);
    await sweeping;
    assert.equal(r.bridge.sessions.get('claude:s1').topicId, null);
    r.hosts.claude.emit('prompt', { id: 's1', text: 'hi' });
    await until(() => r.telegram.topics.length === 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unpin failures are logged once', async () => {
  const r = make();
  r.telegram.unpinAllForumTopicMessages = async () => { throw new Error('not enough rights'); };
  await up(r, 'codex', 't1');
  await up(r, 'codex', 't2');
  await settle();
  assert.equal(r.logs.filter((l) => /unpin/.test(l)).length, 1);
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

test('a dismissed (non-main) session never gets a Topic; one it already had is closed quietly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const topicCacheFile = path.join(dir, 'topics.json');
  try {
    fs.writeFileSync(topicCacheFile, JSON.stringify({ '-100|codex:sub': { topicId: 77, title: 'host-a/codex/main #3' } }));
    const r = make({ topicCacheFile });
    r.at(5);
    r.hosts.codex.emit('dismiss', { id: 'sub' });
    r.hosts.codex.emit('dismiss', { id: 'never-had-one' });
    await until(() => r.telegram.closed.length === 1);
    await settle();
    assert.deepEqual([r.telegram.closed, r.telegram.sent], [[[-100, 77]], []]);
    assert.deepEqual(JSON.parse(fs.readFileSync(topicCacheFile, 'utf8'))['-100|codex:sub'], { topicId: 77, title: 'host-a/codex/main #3', closedAt: 5 });
    r.at(5 + 24 * H); await r.bridge.sweepClosedTopics();
    assert.deepEqual(r.telegram.deleted, [[-100, 77]], 'then deleted like any ended session');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notify posts into a registered session Topic; observedSessions lists main sessions with their cwd', async () => {
  const r = make();
  await up(r, 'codex', 't1');
  await r.bridge.notify('codex:t1', 'pushed b2 → main (+1)');
  await r.bridge.notify('codex:nope', 'dropped');
  await until(() => r.telegram.sent.length === 2);
  assert.equal(texts(r.telegram)[1], 'pushed b2 → main (+1)');
  assert.deepEqual(r.bridge.observedSessions(), [{ key: 'codex:t1', cwd: '/proj', chatId: -100, project: 'proj' }]);
});
