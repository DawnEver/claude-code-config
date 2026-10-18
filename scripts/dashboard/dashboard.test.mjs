import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { verifyInitData, verifyHostToken, newHostToken } from './auth.mjs';
import { parseHostPush, topicUrl, MAX_SESSIONS } from '../shared/dashboard-schema.mjs';
import { Registry } from './registry.mjs';
import { createApi, parseDashboardConfig } from './api.mjs';
import { dashboardConfigFrom } from './deploy.mjs';
import { ago, applyFilters, attention, displayStatus, filterOptions, mockDashboard, stats } from './public/view.mjs';

const BOT_ID = 123456;
const ALICE = 42, MALLORY = 666;
const NOW = 1_800_000_000_000;

// A stand-in for Telegram's signing key: the gateway is given its public half.
const telegram = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', telegram.publicKey)).toString('hex');
const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);

async function initData({ user = ALICE, authDate = NOW / 1000, botId = BOT_ID, key = telegram.privateKey } = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(authDate)), query_id: 'q1', user: JSON.stringify({ id: user, first_name: 'A' }) });
  const check = `${botId}:WebAppData\n${[...params].map(([k, v]) => `${k}=${v}`).sort().join('\n')}`;
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(check));
  params.set('signature', Buffer.from(sig).toString('base64url'));
  params.set('hash', '0'.repeat(64));   // the first-party HMAC, which a third party cannot and need not check
  return params.toString();
}
const opts = { botId: BOT_ID, allowedUserIds: [ALICE], maxAgeSeconds: 3600, now: NOW, publicKey: PUBLIC_KEY };

test('initData: Ed25519-signed for the dashboard bot, fresh and allowlisted only', async () => {
  assert.deepEqual(await verifyInitData(await initData(), opts), { ok: true, userId: ALICE });
  assert.equal((await verifyInitData(await initData({ user: MALLORY }), opts)).status, 403);
  assert.equal((await verifyInitData(await initData({ botId: 999 }), opts)).status, 401, 'opened from another bot');
  assert.equal((await verifyInitData(await initData({ key: other.privateKey }), opts)).status, 401, 'not Telegram\'s key');
  assert.equal((await verifyInitData(await initData({ authDate: NOW / 1000 - 7200 }), opts)).status, 401, 'expired');
  assert.equal((await verifyInitData(await initData({ authDate: NOW / 1000 + 600 }), opts)).status, 401, 'from the future');
  const forged = (await initData()).replace(encodeURIComponent(`"id":${ALICE}`), encodeURIComponent('"id":43'));
  assert.equal((await verifyInitData(forged, opts)).status, 401, 'tampered user');
  for (const bad of [undefined, '', 'signature=zz', 'user=%7B%22id%22%3A42%7D']) assert.equal((await verifyInitData(bad, opts)).status, 401);
});

test('host token: only its own host, by stored hash', async () => {
  const { token, hash } = await newHostToken();
  const hosts = { 'host-a': hash };
  assert.equal(await verifyHostToken('host-a', `Bearer ${token}`, hosts), true);
  assert.equal(await verifyHostToken('host-b', `Bearer ${token}`, hosts), false);
  assert.equal(await verifyHostToken('host-a', `Bearer ${token}x`, hosts), false);
  assert.equal(await verifyHostToken('host-a', token, hosts), false);
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

async function gateway(over = {}) {
  const { token, hash } = await newHostToken();
  let now = NOW;
  const api = createApi(parseDashboardConfig({ botId: BOT_ID, allowedUserIds: [ALICE], hosts: { 'host-a': hash }, ratePerMinute: 1000, ...over }, PUBLIC_KEY),
    { now: () => now });
  const req = (p, init = {}) => api(new Request(`https://dashboard.example${p}`, init));
  return { api, token, req, tick: (ms) => { now += ms; } };
}
const asViewer = async (user) => ({ headers: { authorization: `tma ${await initData({ user })}` } });
const hostPost = (token, body) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) });

test('api: host push and viewer read, each authenticated', async () => {
  const g = await gateway();
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost('wrong-token-wrong-token', push()))).status, 401);
  assert.equal((await g.req('/api/hosts/host-b/snapshot', hostPost(g.token, push()))).status, 401, 'token of another host');
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, '{nope'))).status, 400);
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, { schemaVersion: 1 }))).status, 400);
  assert.equal((await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, 'x'.repeat(300 * 1024)))).status, 413);
  assert.deepEqual(await (await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, push()))).json(), { accepted: true });

  assert.equal((await g.req('/api/dashboard')).status, 401);
  assert.equal((await g.req('/api/dashboard', { headers: { authorization: 'tma user=%7B%22id%22%3A42%7D' } })).status, 401, 'unsigned client claim');
  assert.equal((await g.req('/api/dashboard', await asViewer(MALLORY))).status, 403);
  const res = await g.req('/api/dashboard', await asViewer(ALICE));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /-100\d+/, 'raw chat id never served');
  const snapshot = JSON.parse(body);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.hosts[0].online, true);
  assert.equal(snapshot.hosts[0].sessions[0].hostId, 'host-a');
  assert.equal((await (await g.req('/api/hosts/host-a/sessions', await asViewer(ALICE))).json()).sessions.length, 1);
  assert.equal((await g.req('/api/hosts/host-x/sessions', await asViewer(ALICE))).status, 404);
  assert.equal((await g.req('/api/hosts/%E0%A4%A/sessions', await asViewer(ALICE))).status, 404, 'malformed escape is no 500');
  assert.equal((await g.req('/api/hosts/%E0%A4%A/snapshot', hostPost(g.token, push()))).status, 401);
  assert.equal((await g.req('/api/hosts/host-a/sessions')).status, 401);
  g.tick(61000);
  assert.equal((await (await g.req('/api/dashboard', await asViewer(ALICE))).json()).hosts[0].online, false);
});

test('api: health, unknown routes, rate limit by CF-Connecting-IP', async () => {
  const g = await gateway({ ratePerMinute: 3 });
  const from = (ip) => ({ headers: { 'cf-connecting-ip': ip } });
  assert.deepEqual(await (await g.req('/api/health', from('1.1.1.1'))).json(), { ok: true, schemaVersion: 1 });
  assert.equal((await g.req('/api/nope', from('1.1.1.1'))).status, 401, 'unknown viewer route needs auth first');
  assert.equal((await g.req('/api/dashboard', { method: 'DELETE', ...from('1.1.1.1') })).status, 404);
  assert.equal((await g.req('/api/health', from('1.1.1.1'))).status, 429);
  assert.equal((await g.req('/api/health', from('2.2.2.2'))).status, 200, 'per client');
  g.tick(60000);
  assert.equal((await g.req('/api/health', from('1.1.1.1'))).status, 200, 'a new minute');
});

test('static app: CSP for Telegram framing, no secret in any asset', () => {
  const dir = new URL('./public/', import.meta.url);
  assert.match(fs.readFileSync(new URL('_headers', dir), 'utf8'), /frame-ancestors https:\/\/web\.telegram\.org/);
  for (const f of ['index.html', 'app.js', 'view.mjs']) assert.doesNotMatch(fs.readFileSync(new URL(f, dir), 'utf8'), /\d{6,}:[A-Za-z0-9_-]{30,}/, `${f}: no bot token`);
});

test('config: DASHBOARD_CONFIG fails loudly, and is derived from the shared bridge config', async () => {
  assert.throws(() => parseDashboardConfig({ hosts: {} }), /botId/);
  assert.throws(() => parseDashboardConfig({ botId: BOT_ID, hosts: { 'host-a': 'not-a-hash' } }), /sha256/);
  const { hash } = await newHostToken();
  const bridge = { allowedUserIds: [ALICE], dashboard: { url: 'https://dashboard.example.com', botId: BOT_ID, hosts: { 'host-a': hash }, hostToken: 'local-secret' } };
  const derived = dashboardConfigFrom(bridge);
  assert.deepEqual(derived, { domain: 'dashboard.example.com', config: { botId: BOT_ID, allowedUserIds: [ALICE], hosts: { 'host-a': hash } } });
  assert.ok(!JSON.stringify(derived).includes('local-secret'), 'a host token never reaches the Worker');
  assert.throws(() => dashboardConfigFrom({ ...bridge, dashboard: { ...bridge.dashboard, url: 'https://dashboard.example.com/x' } }), /origin/);
  assert.throws(() => dashboardConfigFrom({ ...bridge, allowedUserIds: [] }), /allowedUserIds/);
});

test('one status vocabulary from native state to the wire', async () => {
  const { STATUS_CODES, STATUS_LABELS } = await import('../bridge/daemon.mjs');
  const { STATUSES } = await import('../shared/dashboard-schema.mjs');
  assert.deepEqual([...new Set(Object.values(STATUS_CODES))].sort(), [...STATUSES].sort());
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), [...STATUSES].sort());
});

test('view: needs-you first, stale is freshness, chips narrow, hosts online first', () => {
  const f = mockDashboard(NOW);
  const all = { group: 'all', host: '', agent: '', project: '' };
  assert.equal(displayStatus(f.hosts[2].sessions[0]), 'stale');
  assert.deepEqual(stats(f), { hostsOnline: 2, hosts: 3, working: 2, attention: 1 });
  assert.deepEqual(attention(f).map((s) => s.project), ['frontend'], 'live sessions waiting for the human');
  assert.deepEqual(filterOptions(f).counts, { all: 5, attention: 1, working: 2, idle: 1, stale: 1 });
  assert.deepEqual(applyFilters(f, all)[0].sessions.map((s) => s.status), ['needs_approval', 'working'], 'most urgent first');
  assert.deepEqual(applyFilters(f, all).map((h) => h.id), ['host-a', 'host-b', 'host-c'], 'offline host last');
  assert.deepEqual(applyFilters(f, { ...all, agent: 'codex' }).map((h) => h.sessions.length), [1, 1]);
  assert.deepEqual(applyFilters(f, { ...all, group: 'attention' }).map((h) => h.id), ['host-a']);
  assert.deepEqual(applyFilters(f, { ...all, group: 'stale', project: 'backend-api' }).map((h) => h.id), ['host-c']);
  assert.equal(ago(new Date(NOW - 5000).toISOString(), NOW), 'just now');
  assert.equal(ago('garbage'), 'never');
});

test('end to end: bridge registry -> push -> gateway -> viewer', async () => {
  const { EventEmitter } = await import('events');
  const { Bridge } = await import('../bridge/daemon.mjs');
  const { DashboardPush } = await import('../bridge/dashboard-push.mjs');
  const g = await gateway();
  const codex = Object.assign(new EventEmitter(), { agent: 'codex', statusSnapshot: () => ({ state: 'running' }), inject: async () => ({}) });
  let thread = 500;
  const tg = { createForumTopic: async () => ({ message_thread_id: ++thread }), sendMessage: async () => [{ message_id: 1 }],
    editMessageText: async () => {}, editForumTopic: async () => {} };
  const bridge = new Bridge({ telegram: tg, adapters: [codex], machine: 'host-a', resolveContext: () => ({ project: 'proj', branch: 'main' }),
    config: { projects: { proj: { chatId: -1001234567890 } }, allowedUserIds: [ALICE], idleCloseMinutes: 30, deleteClosedAfterHours: 24 } });
  await bridge.sessionUp('codex', { id: 'thread-1', cwd: '/secret/home/proj' });
  await bridge.prompt('codex:thread-1', 'go');
  const push = new DashboardPush({ url: 'https://dashboard.example', hostToken: g.token, machine: 'host-a',
    sessions: () => bridge.dashboardSnapshot(), fetch: (url, init) => g.api(new Request(url, init)) });
  assert.equal(await push.tick(), true);
  const snapshot = await (await g.req('/api/dashboard', await asViewer(ALICE))).json();
  const [s] = snapshot.hosts[0].sessions;
  assert.deepEqual([s.id, s.agent, s.project, s.status, s.stale], ['thread-1', 'codex', 'proj', 'working', false]);
  assert.equal(s.topic.url, `https://t.me/c/1234567890/${thread}`);
  assert.ok(!JSON.stringify(snapshot).includes('/secret/home'));
});

test('static app: every script parses (a syntax error only shows as a stuck page)', async () => {
  const { spawnSync } = await import('child_process');
  for (const f of ['app.js', 'view.mjs']) {
    const r = spawnSync(process.execPath, ['--check', new URL(`./public/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
