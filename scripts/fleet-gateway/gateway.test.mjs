import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { verifyInitData, verifyHostToken, newHostToken } from './auth.mjs';
import { parseHostPush, topicUrl, MAX_SESSIONS } from '../shared/fleet-schema.mjs';
import { Registry } from './registry.mjs';
import { createGateway } from './server.mjs';
import { ago, applyFilters, displayStatus, filterOptions, mockFleet, stats } from './public/view.mjs';

const BOT = '123456:TEST-token';
const ALICE = 42, MALLORY = 666;
const NOW = 1_800_000_000_000;

function initData({ user = ALICE, authDate = NOW / 1000, bot = BOT } = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(authDate)), query_id: 'q1', user: JSON.stringify({ id: user, first_name: 'A' }) });
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(bot).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
const opts = { botToken: BOT, allowedUserIds: [ALICE], maxAgeSeconds: 3600, now: NOW };

test('initData: signed, fresh and allowlisted only', () => {
  assert.deepEqual(verifyInitData(initData(), opts), { ok: true, userId: ALICE });
  assert.equal(verifyInitData(initData({ user: MALLORY }), opts).status, 403);
  assert.equal(verifyInitData(initData({ bot: '999:other' }), opts).status, 401, 'signed by another bot');
  assert.equal(verifyInitData(initData({ authDate: NOW / 1000 - 7200 }), opts).status, 401, 'expired');
  assert.equal(verifyInitData(initData({ authDate: NOW / 1000 + 600 }), opts).status, 401, 'from the future');
  const forged = initData().replace(encodeURIComponent(`"id":${ALICE}`), encodeURIComponent('"id":43'));
  assert.equal(verifyInitData(forged, opts).status, 401, 'tampered user');
  for (const bad of [undefined, '', 'hash=zz', 'user=%7B%22id%22%3A42%7D']) assert.equal(verifyInitData(bad, opts).status, 401);
});

test('host token: only its own host, by stored hash', () => {
  const { token, hash } = newHostToken();
  const hosts = { 'host-a': hash };
  assert.equal(verifyHostToken('host-a', `Bearer ${token}`, hosts), true);
  assert.equal(verifyHostToken('host-b', `Bearer ${token}`, hosts), false);
  assert.equal(verifyHostToken('host-a', `Bearer ${token}x`, hosts), false);
  assert.equal(verifyHostToken('host-a', token, hosts), false);
});

const session = (over = {}) => ({ id: 's1', agent: 'claude', project: 'proj', branch: 'main', seat: null, status: 'working',
  lastActivityAt: new Date(NOW).toISOString(), topic: { chatId: -1001234567890, topicId: 77, closed: false }, ...over });
const push = (over = {}) => ({ schemaVersion: 1, bootAt: 1000, seq: 1, sessions: [session()], ...over });

test('schema: whitelists fields, derives a Topic link, never forwards the chat id', () => {
  const p = parseHostPush(push({ sessions: [session({ cwd: '/home/u/x', token: 'secret' }), session({ id: 's2', topic: null, status: 'bogus' }),
    session({ agent: 'gpt' }), session()] }));
  assert.equal(p.sessions.length, 2, 'unknown agent and duplicate dropped');
  assert.deepEqual(Object.keys(p.sessions[0]).sort(), ['agent', 'branch', 'id', 'lastActivityAt', 'project', 'seat', 'status', 'topic']);
  assert.deepEqual(p.sessions[0].topic, { url: 'https://t.me/c/1234567890/77', closed: false });
  assert.equal(p.sessions[1].status, 'unknown');
  assert.equal(p.sessions[1].topic, null);
  assert.equal(topicUrl(-999, 5), null, 'not a supergroup');
  assert.equal(topicUrl(-1001, 0), null);
  assert.equal(parseHostPush(push({ schemaVersion: 2 })), null);
  assert.equal(parseHostPush(push({ seq: 0 })), null);
  assert.equal(parseHostPush({ ...push(), sessions: Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => session({ id: `s${i}` })) }).sessions.length, MAX_SESSIONS);
});

test('registry: ordering per boot, offline after TTL, configured hosts listed before their first push', () => {
  let t = NOW;
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => t });
  assert.deepEqual(r.host('host-b'), { id: 'host-b', online: false, lastSeen: null, sessions: [] });
  assert.equal(r.accept('host-a', parseHostPush(push({ seq: 5 }))), true);
  assert.equal(r.accept('host-a', parseHostPush(push({ seq: 4, sessions: [] }))), false, 'delayed older push');
  assert.equal(r.host('host-a').sessions.length, 1);
  assert.equal(r.accept('host-a', parseHostPush(push({ bootAt: 2000, seq: 1, sessions: [] }))), true, 'a restarted daemon');
  assert.equal(r.accept('host-a', parseHostPush(push({ bootAt: 1000, seq: 9 }))), false, 'late push of the replaced daemon');
  assert.equal(r.host('host-a').sessions.length, 0);
  r.accept('host-a', parseHostPush(push({ bootAt: 2000, seq: 2 })));
  assert.equal(r.host('host-a').online, true);
  assert.equal(r.host('host-a').sessions[0].stale, false);
  t += 60000;
  assert.equal(r.host('host-a').online, false);
  assert.equal(r.host('host-a').sessions[0].stale, true, 'state of an offline host is not live');
  assert.equal(r.host('host-z'), null);
  assert.equal(r.accept('host-b', parseHostPush(push({ bootAt: t + 3600000 }))), false, 'a boot dated ahead of the gateway clock');
});

async function gateway(t, config = {}) {
  const { token, hash } = newHostToken();
  let now = NOW;
  const g = createGateway({ botToken: BOT, allowedUserIds: [ALICE], hosts: { 'host-a': hash }, ttlSeconds: 60,
    initDataMaxAgeSeconds: 3600, trustProxy: false, ratePerMinute: 1000, ...config }, { now: () => now });
  await new Promise((r) => g.server.listen(0, '127.0.0.1', r));
  t.after(() => g.server.close());
  const base = `http://127.0.0.1:${g.server.address().port}`;
  const req = (p, init = {}) => fetch(base + p, init);
  return { ...g, token, req, tick: (ms) => { now += ms; } };
}
const asViewer = (user) => ({ headers: { authorization: `tma ${initData({ user })}` } });
const hostPost = (token, body) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) });

test('gateway: host push and viewer read, each authenticated', async (t) => {
  const g = await gateway(t);
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost('wrong-token-wrong-token', push()))).status, 401);
  assert.equal((await g.req('/api/hosts/host-b/snapshot', hostPost(g.token, push()))).status, 401, 'token of another host');
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, '{nope'))).status, 400);
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, { schemaVersion: 1 }))).status, 400);
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, 'x'.repeat(300 * 1024)))).status, 413);
  const ok = await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, push()));
  assert.deepEqual(await ok.json(), { accepted: true });

  assert.equal((await g.req('/api/fleet')).status, 401);
  assert.equal((await g.req('/api/fleet', { headers: { authorization: 'tma user=%7B%22id%22%3A42%7D' } })).status, 401, 'unsigned client claim');
  assert.equal((await g.req('/api/fleet', asViewer(MALLORY))).status, 403);
  const res = await g.req('/api/fleet', asViewer(ALICE));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /-100\d+/, 'raw chat id never served');
  const fleet = JSON.parse(body);
  assert.equal(fleet.schemaVersion, 1);
  assert.equal(fleet.hosts[0].online, true);
  assert.equal(fleet.hosts[0].sessions[0].hostId, 'host-a');
  assert.equal((await (await g.req('/api/hosts/host-a/sessions', asViewer(ALICE))).json()).sessions.length, 1);
  assert.equal((await g.req('/api/hosts/host-x/sessions', asViewer(ALICE))).status, 404);
  assert.equal((await g.req('/api/hosts/%E0%A4%A/sessions', asViewer(ALICE))).status, 404, 'malformed escape is no 500');
  assert.equal((await g.req('/api/hosts/%E0%A4%A/snapshot', hostPost(g.token, push()))).status, 401);
  assert.equal((await g.req('/api/hosts/host-a/sessions')).status, 401);
  g.tick(61000);
  assert.equal((await (await g.req('/api/fleet', asViewer(ALICE))).json()).hosts[0].online, false);
});

test('gateway: health, static app, unknown routes, rate limit', async (t) => {
  const g = await gateway(t, { ratePerMinute: 6 });
  assert.deepEqual(await (await g.req('/api/health')).json(), { ok: true, schemaVersion: 1 });
  const page = await g.req('/');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors/);
  assert.doesNotMatch(await page.text(), new RegExp(BOT), 'no bot token in the page');
  for (const js of ['/app.js', '/view.mjs']) assert.match((await g.req(js)).headers.get('content-type'), /^text\/javascript/);
  assert.equal((await g.req('/nope')).status, 404);
  assert.equal((await g.req('/api/fleet', { method: 'DELETE' })).status, 404);
  assert.equal((await g.req('/api/health')).status, 429);
});

test('one status vocabulary from native state to the wire', async () => {
  const { STATUS_CODES, STATUS_LABELS } = await import('../bridge/daemon.mjs');
  const { STATUSES } = await import('../shared/fleet-schema.mjs');
  assert.deepEqual([...new Set(Object.values(STATUS_CODES))].sort(), [...STATUSES].sort());
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...STATUSES].sort());
});

test('config: a malformed hosts entry fails loudly', async () => {
  const fs = await import('fs'); const os = await import('os'); const path = await import('path');
  const { readGatewayConfig } = await import('./server.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fgwc-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify({ hosts: { 'host-a': 'not-a-hash' } }));
  assert.throws(() => readGatewayConfig(file, { botToken: BOT, allowedUserIds: [ALICE] }), /host-token/);
});

test('view: stale is freshness, filters narrow, stats count live state only', () => {
  const f = mockFleet(NOW);
  assert.equal(displayStatus(f.hosts[2].sessions[0]), 'stale');
  assert.deepEqual(stats(f), { hostsOnline: 2, hosts: 3, working: 2, attention: 1 });
  assert.ok(filterOptions(f).status.includes('stale'));
  assert.deepEqual(applyFilters(f, { host: '', agent: 'codex', project: '', status: '' }).map((h) => h.sessions.length), [1, 1]);
  assert.deepEqual(applyFilters(f, { host: 'host-c', agent: '', project: '', status: '' }).map((h) => h.id), ['host-c']);
  assert.equal(applyFilters(f, { host: '', agent: '', project: 'backend-api', status: 'stale' })[0].id, 'host-c');
  assert.equal(ago('garbage'), 'never');
});

test('end to end: bridge registry -> push -> gateway -> viewer', async (t) => {
  const { EventEmitter } = await import('events');
  const { Bridge } = await import('../bridge/daemon.mjs');
  const { FleetPush } = await import('../bridge/fleet-push.mjs');
  const g = await gateway(t);
  const codex = Object.assign(new EventEmitter(), { agent: 'codex', statusSnapshot: () => ({ state: 'running' }), inject: async () => ({}) });
  let thread = 500;
  const telegram = { createForumTopic: async () => ({ message_thread_id: ++thread }), sendMessage: async () => [{ message_id: 1 }],
    editMessageText: async () => {}, editForumTopic: async () => {} };
  const bridge = new Bridge({ telegram, adapters: [codex], machine: 'host-a', resolveContext: () => ({ project: 'proj', branch: 'main' }),
    config: { projects: { proj: { chatId: -1001234567890 } }, allowedUserIds: [ALICE], idleCloseMinutes: 30, deleteClosedAfterHours: 24 } });
  await bridge.sessionUp('codex', { id: 'thread-1', cwd: '/secret/home/proj' });
  await bridge.prompt('codex:thread-1', 'go');
  const push = new FleetPush({ url: `http://127.0.0.1:${g.server.address().port}`, hostToken: g.token, machine: 'host-a',
    sessions: () => bridge.fleetSnapshot() });
  assert.equal(await push.tick(), true);
  const fleet = await (await g.req('/api/fleet', asViewer(ALICE))).json();
  const [s] = fleet.hosts[0].sessions;
  assert.deepEqual([s.id, s.agent, s.project, s.status, s.stale], ['thread-1', 'codex', 'proj', 'working', false]);
  assert.equal(s.topic.url, `https://t.me/c/1234567890/${thread}`);
  assert.ok(!JSON.stringify(fleet).includes('/secret/home'));
});
