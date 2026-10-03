import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Bridge, topicTitle } from './daemon.mjs';

const M = 60000, H = 60 * M;
const isCard = m => m.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('status:');
const HOSTS = ['codex', 'claude'];

test('one status card follows native state and authenticates refresh', async () => {
  const r = make();
  let state = 'idle';
  r.hosts.codex.statusSnapshot = () => ({ state });
  await live(r, 'codex', 'card');
  const card = r.telegram.sent.find(m => isCard(m));
  assert.ok(card);
  assert.deepEqual(r.telegram.pinned, [], 'Telegram pins a Topic\'s first message itself');
  assert.match(card.text, /^Idle · since \d\d:\d\d\nChecked \d\d:\d\d$/);
  state = 'running';
  r.hosts.codex.emit('status', { id: 'card' });
  await settle();
  assert.match(r.telegram.edits.at(-1).text, /^Working · since /);
  assert.equal(r.telegram.sent.filter(m => isCard(m)).length, 1);
  const query = { id: 'refresh', from: { id: ALICE }, data: card.replyMarkup.inline_keyboard[0][0].callback_data,
    message: { chat: { id: card.chatId }, message_id: card.message_id, message_thread_id: card.threadId } };
  const count = r.telegram.edits.length;
  await r.bridge.handleUpdate({ callback_query: { ...query, from: { id: MALLORY } } });
  await r.bridge.handleUpdate({ callback_query: { ...query, message: { ...query.message, message_id: 999 } } });
  assert.equal(r.telegram.edits.length, count);
  state = 'idle';
  await r.bridge.handleUpdate({ callback_query: query });
  assert.match(r.telegram.edits.at(-1).text, /^Idle · since /);
  r.bridge.sessionDown('codex:card');
  await settle();
  assert.match(r.telegram.edits.at(-1).text, /^Ended · since /);
  assert.deepEqual(r.telegram.edits.at(-1).replyMarkup.inline_keyboard, []);
  await r.bridge.handleUpdate({ callback_query: query });
  assert.equal(r.telegram.answers.at(-1), 'control inactive');
});

test('status card reuses cached message on restart and status failure does not lose backlog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-'));
  try {
    const file = path.join(dir, 'topics.json');
    fs.writeFileSync(file, JSON.stringify({ '-100|codex:card': { topicId: 77,
      title: 'proj | main | host-a | codex', statusMessageId: 55 } }));
    const r = make({ topicCacheFile: file });
    r.hosts.codex.statusSnapshot = () => ({ state: 'idle' });
    await up(r, 'codex', 'card');
    assert.equal(r.telegram.edits.at(-1).id, 55);
    assert.equal(r.telegram.sent.length, 0);
    const other = make();
    other.hosts.codex.statusSnapshot = () => ({ state: 'running' });
    const send = other.telegram.sendMessage;
    other.telegram.sendMessage = async (chat, text, options) => {
      if (options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('status:')) throw new Error('status send rejected');
      return send(chat, text, options);
    };
    await up(other, 'codex', 's', { backlog: [{ kind: 'final', text: 'complete answer', turnId: 'turn' }] });
    assert.ok(texts(other.telegram).includes('complete answer'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reconnect drains the old offline-card write before showing live status', async () => {
  const r = make();
  let state = 'idle';
  r.hosts.codex.statusSnapshot = () => ({ state });
  await live(r, 'codex', 'card');
  let release;
  const edit = r.telegram.editMessageText;
  r.telegram.editMessageText = async (chat, id, text, options) => {
    if (text.startsWith('Ended')) await new Promise(resolve => { release = resolve; });
    return edit(chat, id, text, options);
  };
  r.bridge.sessionDown('codex:card');
  await until(() => release);
  state = 'running';
  const pending = up(r, 'codex', 'card');
  await settle();
  assert.equal(r.bridge.sessions.has('codex:card'), false);
  release(); await pending;
  assert.match(r.telegram.edits.at(-1).text, /^Working · since /);
});

test('Topic fields use readable separators and display-only project abbreviations', () => {
  assert.equal(topicTitle('host-a', 'plant-studio', 'feat/example', 'codex'), 'plant | feat/example | host-a | codex');
  assert.equal(topicTitle('host-a', 'sample lab', 'main', 'claude'), 'sample | main | host-a | claude');
  for (const [repo, name] of [['acme-lab-lib', 'acme-lib'], ['acme-lab-webui', 'acme-webui'], ['lab-tools', 'lab-tools'], ['acme-lab', 'acme']])
    assert.equal(topicTitle('h', repo, 'main', 'claude'), `${name} | main | h | claude`);
  const title = topicTitle('host-a', 'proj', 'x'.repeat(200), 'codex', 'abcdef');
  assert.ok(Array.from(title).length <= 128);
  assert.ok(title.endsWith(' | host-a | codex · abcdef'));
  assert.ok(Array.from(topicTitle('m'.repeat(200), 'p'.repeat(200), 'b'.repeat(200), 'codex', 'a'.repeat(16))).length <= 128);
});

test('cached active Topics are renamed without replacing their Topic identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-title-'));
  try {
    const file = path.join(dir, 'topics.json');
    fs.writeFileSync(file, JSON.stringify({ '-100|codex:s': { topicId: 77, title: 'host-a/codex/main #4' } }));
    const r = make({ topicCacheFile: file });
    await up(r, 'codex', 's');
    assert.deepEqual(r.telegram.renamed, [[-100, 77, 'proj | main | host-a | codex']]);
    assert.equal(r.bridge.sessions.get('codex:s').topicId, 77);
    assert.equal(r.telegram.topics.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attachments are session scoped and reject files outside the workspace', async () => {
  const r = make();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-'));
  try {
    const file = path.join(dir, 'result.txt');
    fs.writeFileSync(file, 'safe fixture');
    await r.bridge.sessionUp('claude', { id: 'upload', cwd: dir });
    const calls = [];
    r.telegram.sendAttachment = async (...args) => { calls.push(args); return { message_id: 10 }; };
    await r.bridge.sendAttachment('claude:upload', { path: file, kind: 'document' });
    assert.equal(calls[0][0], -999);
    assert.equal(calls[0][2].threadId, 100);
    await assert.rejects(r.bridge.sendAttachment('claude:upload', { path: path.join(dir, '..', 'outside.txt') }));
    await assert.rejects(r.bridge.sendAttachment('claude:missing', { path: file }));
    fs.writeFileSync(path.join(dir, '.env'), 'secret fixture');
    await assert.rejects(r.bridge.sendAttachment('claude:upload', { path: path.join(dir, '.env') }));
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeTelegram() {
  const t = { sent: [], edits: [], topics: [], renamed: [], answers: [], closed: [], reopened: [], deleted: [], pinned: [] };
  let nextTopic = 100, nextMsg = 1;
  Object.assign(t, {
    createForumTopic: async (chatId, name) => { t.topics.push([chatId, name]); return { message_thread_id: nextTopic++ }; },
    editForumTopic: async (chatId, threadId, name) => { t.renamed.push([chatId, threadId, name]); return true; },
    sendMessage: async (chatId, text, opts = {}) => { const message_id = nextMsg++; t.sent.push({ chatId, text, ...opts, message_id }); return [{ message_id }]; },
    editMessageText: async (chatId, id, text, options = {}) => { t.edits.push({ chatId, id, text, ...options }); },
    answerCallbackQuery: async (id, text) => { t.answers.push(text); },
    closeForumTopic: async (c, id) => { t.closed.push([c, id]); return true; },
    reopenForumTopic: async (c, id) => { t.reopened.push([c, id]); return true; },
    deleteForumTopic: async (c, id) => { t.deleted.push([c, id]); return true; },
    pinChatMessage: async (c, id) => { t.pinned.push([c, id]); return true; },
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
  h.questionAnswers = []; h.released = [];
  h.answerQuestion = (ref, answers, id) => { h.questionAnswers.push([ref, answers, id]); return true; };
  h.releaseQuestion = (ref, id) => { h.released.push([ref, id]); return true; };
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
// A Topic is created lazily: bring the session up, then type one prompt (its first post).
const live = async (r, agent, id, extra = {}) => { await up(r, agent, id, extra); await r.bridge.prompt(`${agent}:${id}`, 'go'); };
const texts = (t) => t.sent.map((s) => s.text);
const approvalCallback = (post, from = ALICE, accept = true) => ({ callback_query: {
  id: 'q', from: { id: from }, data: post.replyMarkup.inline_keyboard[0][accept ? 0 : 1].callback_data,
  message: { chat: { id: post.chatId }, message_id: post.message_id, message_thread_id: post.threadId, text: post.text },
} });

test('approval buttons cannot be reused across daemon restarts or wrong origins', async () => {
  const old = make({ config: { approvalsFromTelegram: true } });
  await up(old, 'codex', 'old');
  await old.bridge.approval('codex:old', { ref: 'old-ref', summary: 'old', answerable: true });
  const current = make({ config: { approvalsFromTelegram: true } });
  await up(current, 'codex', 'new');
  await current.bridge.approval('codex:new', { ref: 'new-ref', summary: 'new', answerable: true });
  await current.bridge.handleUpdate(approvalCallback(old.telegram.sent.at(-1)));
  assert.deepEqual(current.hosts.codex.answered, [], 'old button must not approve a new request');
  const post = current.telegram.sent.at(-1);
  for (const field of ['chat', 'message_id', 'message_thread_id']) {
    const q = approvalCallback(post);
    q.callback_query.message[field] = field === 'chat' ? { id: -200 } : 999;
    await current.bridge.handleUpdate(q);
  }
  const missing = approvalCallback(post); delete missing.callback_query.message;
  await current.bridge.handleUpdate(missing);
  assert.deepEqual(current.hosts.codex.answered, [], 'wrong or missing origin must not dispatch');
  await current.bridge.handleUpdate(approvalCallback(post));
  assert.deepEqual(current.hosts.codex.answered, [['new-ref', true, 'new']]);
  assert.equal(current.telegram.answers.at(-1), 'submitted', 'submission is not proof of native acceptance');
});

for (const agent of HOSTS) {
  test(`${agent}: ended sessions and failed sends invalidate approval controls`, async () => {
    const r = make({ config: { approvalsFromTelegram: true } });
    await up(r, agent, 'x');
    await r.bridge.approval(`${agent}:x`, { ref: 'r', summary: 'perm', answerable: true });
    const post = r.telegram.sent.at(-1);
    r.bridge.sessionDown(`${agent}:x`);
    await r.bridge.handleUpdate(approvalCallback(post));
    assert.deepEqual(r.hosts[agent].answered, []);
    assert.equal(r.bridge.approvals.size, 0);
    await up(r, agent, 'y');
    r.telegram.sendMessage = async () => { throw new Error('offline'); };
    await r.bridge.approval(`${agent}:y`, { ref: 'failed', summary: 'perm', answerable: true });
    assert.equal(r.bridge.approvals.size, 0, 'undelivered controls have no pending correlation');
  });
}

test('approval binds the last chunk and cannot revive a request resolved during delivery', async () => {
  const r = make({ config: { approvalsFromTelegram: true } });
  await up(r, 'codex', 'x');
  const send = r.telegram.sendMessage;
  r.telegram.sendMessage = async (...args) => {
    const messages = await send(...args);
    return [{ message_id: 999 }, ...messages];
  };
  await r.bridge.approval('codex:x', { ref: 'multi', summary: 'long', answerable: true });
  await r.bridge.handleUpdate(approvalCallback(r.telegram.sent.at(-1)));
  assert.deepEqual(r.hosts.codex.answered, [['multi', true, 'x']]);
  r.telegram.sendMessage = async (...args) => {
    r.hosts.codex.emit('approval-resolved', { ref: 'race' });
    return send(...args);
  };
  await r.bridge.approval('codex:x', { ref: 'race', summary: 'race', answerable: true });
  await r.bridge.handleUpdate(approvalCallback(r.telegram.sent.at(-1)));
  assert.equal(r.hosts.codex.answered.length, 1);
  assert.equal(r.bridge.approvals.size, 0);
});

test('failed Topic creation never posts into the shared general chat', async () => {
  const r = make();
  r.telegram.createForumTopic = async () => { throw new Error('create outcome unknown'); };
  await up(r, 'codex', 'x');
  await r.bridge.final('codex:x', 'private answer');
  assert.deepEqual(r.telegram.sent, []);
  assert.ok(r.logs.some((line) => /not delivered/.test(line)), 'failure remains visible locally');
});

test('definite Topic creation rejection retries on later activity, uncertain creation does not', async () => {
  for (const uncertain of [false, true]) {
    const r = make();
    const create = r.telegram.createForumTopic;
    let calls = 0;
    r.telegram.createForumTopic = async (...args) => {
      if (calls++ === 0) throw Object.assign(new Error('creation failed'), uncertain ? { uncertain: true } : { code: 400 });
      return create(...args);
    };
    await up(r, 'codex', 'x');
    await r.bridge.final('codex:x', 'answer');
    await r.bridge.final('codex:x', 'again');
    assert.equal(calls, uncertain ? 1 : 2);
    assert.equal(r.telegram.sent.length, uncertain ? 0 : 1);
  }
});

test('native resolution withdraws approvals held during Topic creation', async () => {
  const r = make({ config: { approvalsFromTelegram: true } });
  const create = r.telegram.createForumTopic;
  r.telegram.createForumTopic = async (...args) => {
    r.hosts.codex.emit('approval', { id: 'x', ref: 'race', summary: 'race', answerable: true });
    r.hosts.codex.emit('approval-resolved', { ref: 'race' });
    return create(...args);
  };
  await up(r, 'codex', 'x', { backlog: [{ kind: 'prompt', text: 'hi' }] });   // creation during bring-up
  assert.equal(r.bridge.approvals.size, 0);
  assert.deepEqual(texts(r.telegram), ['> hi'], 'resolved held request never gets buttons');
});

test('same native refs in two sessions withdraw independently and repeated clicks submit once', async () => {
  const r = make({ config: { approvalsFromTelegram: true } });
  await up(r, 'claude', 'x'); await up(r, 'claude', 'y');
  await r.bridge.approval('claude:x', { ref: 'same', summary: 'x', answerable: true });
  const old = r.telegram.sent.at(-1);
  await r.bridge.approval('claude:y', { ref: 'same', summary: 'y', answerable: true });
  const current = r.telegram.sent.at(-1);
  r.hosts.claude.emit('approval-resolved', { id: 'x', ref: 'same', reason: 'correlation-withdrawn' });
  await r.bridge.handleUpdate(approvalCallback(old));
  let resolve;
  r.hosts.claude.answerApproval = (ref, yes, id) => {
    r.hosts.claude.answered.push([ref, yes, id]);
    return new Promise((r) => { resolve = r; });
  };
  const first = r.bridge.handleUpdate(approvalCallback(current));
  await r.bridge.handleUpdate(approvalCallback(current));
  assert.deepEqual(r.hosts.claude.answered, [['same', true, 'y']]);
  resolve(true); await first;
  assert.equal(r.telegram.answers.at(-1), 'submitted');
});

test('topics: <machine>/<agent>/<branch> in the project group, fallback otherwise, numbered per group', async () => {
  const r = make();
  await live(r, 'codex', 't1', { branch: 'feat/x' });
  await r.bridge.sessionUp('claude', { id: 's1', cwd: '/elsewhere' });
  await r.bridge.prompt('claude:s1', 'go');
  await live(r, 'codex', 't2', { branch: 'feat/x' });
  assert.deepEqual(r.telegram.topics.slice(0, 2), [[-100, 'proj | feat/x | host-a | codex'], [-999, 'other | main | host-a | claude']]);
  assert.match(r.telegram.topics[2][1], /^proj \| feat\/x \| host-a \| codex · [a-f0-9]{6}$/);
  assert.deepEqual(r.telegram.pinned, []);
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
      await until(() => r.telegram.sent.length === 2);
      assert.deepEqual(texts(r.telegram), ['> hi', 'Hello!']);

      r.at(29 * M); await r.bridge.closeIdle();
      assert.deepEqual(r.telegram.closed, [], '29m: still open');
      r.at(30 * M); await r.bridge.closeIdle(); await r.bridge.closeIdle();
      assert.deepEqual(r.telegram.closed, [[-100, 100]], 'closed once, quietly');
      assert.equal(r.telegram.sent.length, 2, 'no message on idle close');
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
      await until(() => r.telegram.sent.length === 3);
      await settle();
      assert.deepEqual(texts(r.telegram).slice(2), ['awake'], 'inject not echoed');
      assert.equal(r.telegram.topics.length, 1);

      r.at(40 * H);
      host.emit('down', { id: 'x' });
      await until(() => r.telegram.closed.length === 2);
      assert.equal(r.telegram.sent.length, 3, 'no message on end');
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
      await live(a, agent, 'x');
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
    host.emit('up', { id: 'x', cwd: '/proj', backlog: [{ kind: 'prompt', text: 'hi', turnId: 'T1' }] });
    host.emit('prompt', { id: 'x', turnId: 'T1', text: 'hi' });
    host.emit('final', { id: 'x', turnId: 'T1', text: 'Hello!' });
    await until(() => open);
    open();
    await until(() => r.telegram.sent.length === 2);
    await settle();
    assert.deepEqual(texts(r.telegram), ['> hi', 'Hello!']);
  });

  test(`${agent}: an idle session up->down makes no Telegram call; the first activity creates the Topic`, async () => {
    const r = make();
    await up(r, agent, 'old');
    r.at(1000 * M); await r.bridge.closeIdle();
    r.hosts[agent].emit('down', { id: 'old' });
    await settle();
    assert.deepEqual([r.telegram.topics, r.telegram.sent, r.telegram.closed], [[], [], []]);
    await up(r, agent, 'idle');
    r.hosts[agent].emit('prompt', { id: 'idle', text: 'back again' });
    await until(() => r.telegram.sent.length === 1);
    assert.deepEqual(texts(r.telegram), ['> back again']);
    assert.equal(r.telegram.topics.length, 1);
  });

  test(`${agent}: the first activity creates the Topic with the status card as its first message, no explicit pin`, async () => {
    const r = make();
    r.hosts[agent].statusSnapshot = () => ({ state: 'running' });
    await up(r, agent, 'x');
    assert.deepEqual([r.telegram.topics, r.telegram.sent], [[], []], 'up alone stays silent');
    r.hosts[agent].emit('prompt', { id: 'x', text: 'hi' });
    await until(() => r.telegram.sent.length === 2);
    assert.equal(r.telegram.topics.length, 1);
    assert.ok(isCard(r.telegram.sent[0]), 'card first');
    assert.equal(r.telegram.sent[0].threadId, 100);
    assert.equal(r.telegram.sent[1].text, '> hi');
    assert.deepEqual(r.telegram.pinned, []);
    r.bridge.sessionDown(`${agent}:x`);
    await until(() => r.telegram.closed.length === 1);
    assert.match(r.telegram.edits.at(-1).text, /^Ended · since /);
    assert.equal(r.telegram.sent.length, 2, 'end is an edit, not a message');
  });

  test(`${agent}: approvals are notices by default; opt-in buttons honour only the allowlist`, async () => {
    const off = make();
    await live(off, agent, 'x');
    off.hosts[agent].emit('approval', { id: 'x', ref: 'r1', summary: '$ rm x', answerable: true });
    await until(() => off.telegram.sent.length === 2);
    assert.match(texts(off.telegram)[1], /answer locally or via official remote/);
    await off.bridge.handleUpdate({ callback_query: { id: 'q', data: 'ap:1:y', from: { id: ALICE } } });
    assert.deepEqual(off.hosts[agent].answered, []);

    const on = make({ config: { approvalsFromTelegram: true } });
    await live(on, agent, 'x');
    on.hosts[agent].emit('approval', { id: 'x', ref: 'r1', summary: '$ rm x', answerable: true });
    await until(() => on.telegram.sent.length === 2);
    const post = on.telegram.sent[1];
    assert.match(post.replyMarkup.inline_keyboard[0][0].callback_data, /^ap:[a-f0-9]{32}:y$/);
    await on.bridge.handleUpdate(approvalCallback(post, MALLORY));
    assert.equal(on.telegram.answers.at(-1), 'not allowed');
    await on.bridge.handleUpdate(approvalCallback(post, ALICE, false));
    assert.deepEqual(on.hosts[agent].answered, [['r1', false, 'x']]);
    await on.bridge.handleUpdate(approvalCallback(post));
    assert.equal(on.telegram.answers.at(-1), 'control inactive');
    on.hosts[agent].emit('approval', { id: 'x', ref: 'r2', summary: 'perm', answerable: false });
    await until(() => on.telegram.sent.length === 3);
    assert.equal(on.telegram.sent[2].replyMarkup, undefined, 'unanswerable kinds never get buttons');
  });

  test(`${agent}: only what needs the human alerts them; the rest is silent`, async () => {
    const r = make();
    await live(r, agent, 'x');
    r.hosts[agent].emit('final', { id: 'x', text: 'done' });
    r.hosts[agent].emit('approval', { id: 'x', ref: 'r1', summary: '$ rm x', answerable: true });
    r.hosts[agent].emit('final', { id: 'x', text: 'boom', status: 'failed' });
    await until(() => r.telegram.sent.length === 4);
    assert.deepEqual(r.telegram.sent.slice(1).map((m) => m.alert ?? null), [null, [ALICE], [ALICE]]);
  });
}

test('strangers are dropped; /status, /interrupt go through the host interface', async () => {
  const r = make();
  await live(r, 'codex', 't1');                         // topic 100
  await live(r, 'claude', 's1', { branch: 'dev' });     // topic 101
  const before = r.telegram.sent.length;
  await r.bridge.handleUpdate(msg(MALLORY, 'rm -rf /'));
  assert.deepEqual(r.hosts.codex.injected, []);
  assert.equal(r.telegram.sent.length, before);
  await r.bridge.handleUpdate(msg(ALICE, '/status@my_bot', 100));
  await until(() => texts(r.telegram).at(-1) === 'proj | main | host-a | codex: idle');
  await r.bridge.handleUpdate(msg(ALICE, '/interrupt', 100));
  await until(() => texts(r.telegram).at(-1) === 'interrupt sent');
  await r.bridge.handleUpdate(msg(ALICE, '/interrupt', 101));
  await until(() => /not available for claude/.test(texts(r.telegram).at(-1)));
});

test('an inject that fails is reported in the Topic', async () => {
  const r = make();
  r.hosts.claude.inject = async () => { throw new Error('channel disconnected'); };
  await live(r, 'claude', 's1');
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
  await live(r, 'codex', 't1');
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

test('a re-attach never binds to a Topic whose deletion is in flight', async () => {
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
    await up(r, 'claude', 's1');
    assert.notEqual(r.bridge.sessions.get('claude:s1').topicId, 55);
    await r.bridge.final('claude:s1', 'new answer');
    assert.equal(r.telegram.sent.at(-1).threadId, 100);
    release(true);
    await sweeping;
    assert.equal(r.bridge.sessions.get('claude:s1').topicId, 100);
    assert.equal(r.bridge.topics.get('-100|claude:s1').topicId, 100, 'old delete cannot remove replacement cache');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed in-flight deletion retains the old Topic retry without replacing the live binding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  try {
    const topicCacheFile = path.join(dir, 'topics.json');
    fs.writeFileSync(topicCacheFile, JSON.stringify({ '-100|claude:s1': { topicId: 55, title: 'old', closedAt: 0 } }));
    const r = make({ topicCacheFile });
    let reject;
    r.telegram.deleteForumTopic = () => new Promise((res, rej) => { reject = rej; });
    r.at(25 * H);
    const sweeping = r.bridge.sweepClosedTopics();
    await until(() => reject);
    await live(r, 'claude', 's1');
    reject(new Error('offline')); await sweeping;
    r.telegram.deleteForumTopic = async (c, id) => { r.telegram.deleted.push([c, id]); };
    await r.bridge.sweepClosedTopics();
    assert.deepEqual(r.telegram.deleted, [[-100, 55]], 'failed cleanup remains retryable');
    assert.equal(r.bridge.topics.get('-100|claude:s1').topicId, 100);
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


test('fleetSessions lists every registered session with its status', async () => {
  const r = make();
  r.hosts.codex.statusSnapshot = () => ({ state: 'running' });
  await up(r, 'codex', 'quiet');
  await live(r, 'codex', 'busy');
  assert.equal(r.bridge.fleetSessions().length, 2, 'a session without a Topic is still running here');
  assert.ok(r.bridge.fleetSessions().every((x) => x.status === 'Working'));
});

test('a failed Topic rename keeps the cached title and session, and is logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-title-'));
  try {
    const file = path.join(dir, 'topics.json');
    fs.writeFileSync(file, JSON.stringify({ '-100|codex:s': { topicId: 77, title: 'host-a/codex/main #4' } }));
    const r = make({ topicCacheFile: file });
    r.telegram.editForumTopic = async () => { throw new Error('not enough rights'); };
    await up(r, 'codex', 's');
    const s = r.bridge.sessions.get('codex:s');
    assert.deepEqual([s.topicId, s.title], [77, 'host-a/codex/main #4']);
    assert.ok(r.logs.some((l) => /editForumTopic: not enough rights/.test(l)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const QS = [{ id: 'q1', header: 'Colour', question: 'Which colour?', isOther: false, isSecret: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: '' }] },
  { id: 'q2', header: 'Name', question: 'Name it', isOther: true, isSecret: false, options: null }];
const tap = (post, from = ALICE, i = 0) => ({ callback_query: { id: 'q', from: { id: from }, data: post.replyMarkup.inline_keyboard[i][0].callback_data,
  message: { chat: { id: post.chatId }, message_id: post.message_id, message_thread_id: post.threadId, text: post.text } } });

for (const agent of HOSTS) {
  test(`${agent}: questions get one button per option and text replies, without the approvals opt-in`, async () => {
    const r = make();
    await live(r, agent, 'x');
    await r.bridge.question(`${agent}:x`, { ref: 'ref1', questions: QS, answerable: true });
    const [first, second] = r.telegram.sent.slice(-2);
    assert.match(first.text, /Which colour?/);
    assert.deepEqual(first.replyMarkup.inline_keyboard.map((row) => row[0].text), ['Red', 'Blue']);
    assert.ok(first.alert?.includes(ALICE));
    assert.match(second.text, /Name it\n\(reply with text to answer\)$/);
    assert.equal(second.replyMarkup, undefined);
    await r.bridge.handleUpdate(tap(first, MALLORY, 1));
    await r.bridge.handleUpdate({ callback_query: { ...tap(first, ALICE, 1).callback_query, message: { ...tap(first).callback_query.message, message_id: 999 } } });
    assert.deepEqual(r.telegram.answers, ['not allowed', 'control inactive']);
    await r.bridge.handleUpdate(tap(first, ALICE, 1));
    assert.equal(r.telegram.answers.at(-1), 'answered');
    assert.match(r.telegram.edits.at(-1).text, /-> Blue/);
    assert.deepEqual(r.hosts[agent].questionAnswers, [], 'sent only once every question is answered');
    await r.bridge.handleUpdate(msg(ALICE, 'Fido'));
    assert.deepEqual(r.hosts[agent].questionAnswers, [['ref1', { q1: ['Blue'], q2: ['Fido'] }, 'x']]);
    assert.deepEqual(r.hosts[agent].injected, [], 'a text answer is not a prompt');
    await r.bridge.handleUpdate(tap(first, ALICE, 0));
    assert.equal(r.telegram.answers.at(-1), 'control inactive', 'answered once');
    await r.bridge.handleUpdate(msg(ALICE, 'next task'));
    assert.equal(r.hosts[agent].injected.length, 1);
  });
}

test('a question only answerable locally is posted without controls; replies stay prompts', async () => {
  const r = make();
  await live(r, 'claude', 'x');
  await r.bridge.question('claude:x', { ref: 'r', questions: QS, answerable: false });
  const post = r.telegram.sent.at(-1);
  assert.match(post.text, /answer locally/);
  assert.match(post.text, /Which colour\?\n- Red: warm\n- Blue\n\n\[Name\] Name it$/);
  assert.equal(post.replyMarkup, undefined);
  await r.bridge.handleUpdate(msg(ALICE, 'hello'));
  assert.equal(r.hosts.claude.injected.length, 1);
});

test('a question answered locally first withdraws its controls; an undeliverable one is released', async () => {
  const r = make();
  await live(r, 'codex', 'x');
  await r.bridge.question('codex:x', { ref: 'r', questions: QS.slice(0, 1), answerable: true });
  const post = r.telegram.sent.at(-1);
  r.hosts.codex.emit('question-resolved', { ref: 'r' });
  await r.bridge.handleUpdate(tap(post));
  assert.equal(r.telegram.answers.at(-1), 'control inactive');
  const quiet = make({ config: { fallbackChatId: null } });
  await quiet.bridge.sessionUp('claude', { id: 'y', cwd: '/elsewhere' });
  await quiet.bridge.question('claude:y', { ref: 'r2', questions: QS, answerable: true });
  assert.deepEqual(quiet.hosts.claude.released, [['r2', 'y']]);
});

test('waiting-input reads Needs input', async () => {
  const r = make();
  r.hosts.codex.statusSnapshot = () => ({ state: 'waiting-input' });
  await up(r, 'codex', 'q');
  assert.equal(r.bridge.fleetSessions()[0].status, 'Needs input');
});
