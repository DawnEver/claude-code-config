import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { verifyInitData, verifyHostToken, newHostToken } from './auth.mjs';
import { parseHostPush, topicUrl, MAX_SESSIONS } from '../shared/dashboard-schema.mjs';
import { Registry } from './registry.mjs';
import { createApi, parseDashboardConfig } from './api.mjs';
import { dashboardConfigFrom, menuRequest } from './deploy.mjs';
import { demoMasker } from './public/demo.mjs';
import { ago, applyFilters, attention, displayStatus, filterOptions, mockDashboard, quotaAlerts, quotaAlertsFor, alertKey, unreadEvents, quotaView, stats, tabs, quotaByHost, accountTag, timeTicks, stateAge, groupSessions, configView, verdictText, resetText, windowLabel, bestAccounts, emailName, amount } from './public/view.mjs';

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
  assert.deepEqual(Object.keys(p.sessions[0]).sort(), ['account', 'agent', 'branch', 'id', 'lastActivityAt', 'project', 'seat', 'status', 'topic']);
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
  assert.deepEqual(r.host('host-b'), { id: 'host-b', online: false, lastSeen: null, sessions: [], config: null });
  assert.equal(r.accept('host-a', parseHostPush(push({ seq: 5 }))).accepted, true);
  assert.equal(r.accept('host-a', parseHostPush(push({ seq: 4, sessions: [] }))).accepted, false, 'delayed older push');
  assert.equal(r.host('host-a').sessions.length, 1);
  assert.equal(r.accept('host-a', parseHostPush(push({ bootAt: 2000, seq: 1, sessions: [] }))).accepted, true, 'a restarted daemon');
  assert.equal(r.accept('host-a', parseHostPush(push({ bootAt: 1000, seq: 9 }))).accepted, false, 'late push of the replaced daemon');
  assert.equal(r.host('host-a').sessions.length, 0);
  r.accept('host-a', parseHostPush(push({ bootAt: 2000, seq: 2 })));
  assert.equal(r.host('host-a').online, true);
  assert.equal(r.host('host-a').sessions[0].stale, false);
  t += 60000;
  assert.equal(r.host('host-a').online, false);
  assert.equal(r.host('host-a').sessions[0].stale, true, 'state of an offline host is not live');
  assert.equal(r.host('host-z'), null);
  assert.equal(r.accept('host-b', parseHostPush(push({ bootAt: t + 3600000 }))).accepted, false, 'a boot dated ahead of the gateway clock');
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
  assert.deepEqual(await (await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, push()))).json(), { accepted: true, configChanges: [] });

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
  assert.deepEqual(await (await g.req('/api/health', from('1.1.1.1'))).json(), { ok: true, schemaVersion: 1, version: null });
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
  const withBot = { ...bridge, dashboard: { ...bridge.dashboard, botToken: `${BOT_ID}:${'x'.repeat(35)}` } };
  assert.ok(!JSON.stringify(dashboardConfigFrom(withBot)).includes('x'.repeat(35)), 'the bot token never reaches the Worker');
});

test('set-menu: the local bot token must be the configured bot', () => {
  const g = { url: 'https://dashboard.example.com', botId: BOT_ID };
  assert.deepEqual(menuRequest(g, `${BOT_ID}:${'a'.repeat(35)}`).menu_button, { type: 'web_app', text: 'Dashboard', web_app: { url: g.url } });
  assert.throws(() => menuRequest(g, null), /local settings/);
  assert.throws(() => menuRequest(g, `999:${'a'.repeat(35)}`), /not the bot/);
  assert.throws(() => menuRequest({ ...g, url: 'http://dashboard.example.com' }, `${BOT_ID}:${'a'.repeat(35)}`), /https/);
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
  for (const f of ['app.js', 'view.mjs', 'demo.mjs']) {
    const r = spawnSync(process.execPath, ['--check', new URL(`./public/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

const HR = 3600000;
const account = (over = {}) => ({ key: 'claude:a@example.com|u1', agent: 'claude', label: 'team-a', email: 'a@example.com', detail: 'Team A',
  problems: [], at: NOW - 60000, resetCredits: null, extraReset: null,
  windows: [{ k: '5h', used: 60, resetsAt: NOW + 3 * HR, windowMs: 5 * HR, cells: [1.5, 1.5, -1, null], forecast: { atReset: 150, eta: NOW + 1.3 * HR, short: true } }], ...over });

test('schema: accounts are whitelisted and bounded like sessions', () => {
  const p = parseHostPush(push({ accounts: [account({ token: 'x', windows: [{ ...account().windows[0], k: '5h; drop', extra: 1 }] }),
    account({ key: 'codex:b', agent: 'codex', extraReset: { at: NOW, url: 'javascript:alert(1)' }, resetCredits: { count: 2, expiries: [NOW, 'x'] } }),
    { agent: 'gpt', key: 'z' }] }));
  assert.equal(p.accounts.length, 2, 'unknown agent dropped');
  assert.ok(!('token' in p.accounts[0]));
  assert.ok(!('aliases' in parseHostPush(push({ accounts: [account({ aliases: [null, 'team-a'] })] })).accounts[0]), 'local config-dir knowledge stays local');
  assert.deepEqual(p.accounts[0].windows, [], 'a malformed window key is dropped');
  assert.equal(p.accounts[1].extraReset.url, null, 'only https links');
  assert.deepEqual(p.accounts[1].resetCredits, { count: 2, expiries: [NOW, null] });
  assert.deepEqual(parseHostPush(push()).accounts, [], 'a host without quota pushes no accounts');
});

test('registry: one account across hosts, its freshest reading, with every host on it', () => {
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => NOW });
  r.accept('host-a', parseHostPush(push({ accounts: [account({ at: NOW - 600000, detail: 'old' })] })));
  r.accept('host-b', parseHostPush(push({ accounts: [account({ at: NOW - 60000, detail: 'new' })] })));
  const [a, ...rest] = r.snapshot().accounts;
  assert.equal(rest.length, 0);
  assert.equal(a.detail, 'new');
  assert.deepEqual(a.hosts, ['host-a', 'host-b']);
});

test('view: quota verdict on the reader\'s clock; stale readings are floors that forecast nothing', () => {
  const q = quotaView(account(), NOW);
  assert.deepEqual([q.verdict, q.left, q.bind.k], ['short', 40, '5h']);
  assert.equal(Math.round(q.windows[0].pace), 40, 'even pace from the clock, not the host');
  const old = quotaView(account({ at: NOW - 30 * 60000 }), NOW);
  assert.equal(old.stale, true);
  assert.equal(old.windows[0].forecast, null);
  assert.equal(old.verdict, 'ok', 'no forecast, no run-out claim');
  assert.equal(quotaView(account({ windows: [{ ...account().windows[0], used: 100, forecast: null }] }), NOW).verdict, 'exhausted');
  const renewed = quotaView(account(), NOW + 4 * HR);
  assert.equal(renewed.windows[0].renewed, true);
  assert.equal(renewed.verdict, 'none');
  const hit = (over = {}) => account({ key: 'k2', windows: [{ ...account().windows[0], used: 100, forecast: null, ...over }] });
  assert.deepEqual(quotaAlerts({ accounts: [account(), hit()] }, NOW).map((x) => x.key), ['k2'], 'a hit limit; a run-out 1.3h away is only shown');
  const soon = account({ key: 'k3', windows: [{ ...account().windows[0], forecast: { atReset: 150, eta: NOW + 0.5 * HR, short: true } }] });
  assert.deepEqual(quotaAlerts({ accounts: [account(), soon] }, NOW).map((x) => x.key), ['k3'], 'a run-out within the hour is an alert');
  assert.equal(quotaAlerts({ accounts: [account({ at: NOW + 0.3 * HR })] }, NOW + 0.3 * HR).length, 1, 'the threshold is judged on the reader clock');
  const [read] = quotaAlerts({ accounts: [hit()] }, NOW);
  assert.deepEqual(quotaAlerts({ accounts: [hit()] }, NOW, [alertKey(read)]), [], 'a read alert leaves the card');
  const next = hit({ resetsAt: account().windows[0].resetsAt + 5 * HR });
  assert.equal(quotaAlerts({ accounts: [next] }, NOW, [alertKey(read)]).length, 1, 'a new window period is a new alert');
});

test('view: a session row says how long it has been in its state', () => {
  const s = (status, min, stale = false) => ({ status, stale, lastActivityAt: new Date(NOW - min * 60000).toISOString() });
  assert.equal(stateAge(s('needs_input', 12), NOW), 'waiting 12m');
  assert.equal(stateAge(s('needs_approval', 0.5), NOW), 'waiting <1m');
  assert.equal(stateAge(s('idle', 125), NOW), 'idle 2h');
  assert.equal(stateAge(s('working', 3 * 1440), NOW), 'working 3d');
  assert.equal(stateAge(s('idle', 125, true), NOW), '2h ago', 'a stale session claims no state');
  assert.equal(stateAge({ status: 'idle', lastActivityAt: null }, NOW), 'never');
});

test('view: sessions group by host as filtered, or by project across hosts', () => {
  const hosts = applyFilters(mockDashboard(NOW), {});
  assert.equal(groupSessions(hosts, 'host'), hosts);
  const g = groupSessions(hosts, 'project');
  assert.deepEqual(g.map((x) => x.id), [...new Set(hosts.flatMap((h) => h.sessions.map((s) => s.project ?? 'unknown project')))].sort());
  assert.equal(g.reduce((n, x) => n + x.sessions.length, 0), hosts.reduce((n, h) => n + h.sessions.length, 0), 'every session once');
  assert.equal(groupSessions([{ id: 'h', online: false, sessions: [{ project: 'p', status: 'idle' }] }, { id: 'i', online: true, sessions: [{ project: 'p', status: 'needs_input' }] }], 'project')[0].sessions[0].status,
    'needs_input', 'merged groups keep urgency order');
});

test('view: tabs count each view and flag quota that needs the human; no accounts, no tabs', () => {
  const m = mockDashboard(NOW);
  assert.deepEqual(tabs(m, NOW), { sessions: 5, quota: 2, alert: true, events: 2, unseen: 2, show: true });
  assert.equal(tabs(m, NOW, m.events[1].at).unseen, 1, 'only events newer than the last look');
  assert.equal(tabs(m, NOW, m.events[0].at).unseen, 0);
  assert.equal(tabs(m, NOW, null, quotaAlerts(m, NOW).map(alertKey)).alert, false, 'read alerts do not flag the quota tab');
  assert.deepEqual(tabs({ hosts: [] }, NOW), { sessions: 0, quota: 0, alert: false, events: 0, unseen: 0, show: false });
  assert.deepEqual(unreadEvents(m.events, m.events[1].at), [m.events[0]], 'events read on an earlier visit are cleared');
  assert.deepEqual(unreadEvents(m.events, null), m.events, 'first visit: everything');
  assert.deepEqual(unreadEvents(m.events, m.events[0].at), []);
  assert.equal(tabs(m, NOW, m.events[0].at, [], m.events[0].at).events, 0, 'the tab counts what it lists, never a cleared event');
});

test('alerts are events: a change once, judged on the merged account, so two hosts on one seat alert once', () => {
  let t = NOW;
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => t });
  const hit = account({ windows: [{ ...account().windows[0], used: 100, forecast: null }] });
  assert.deepEqual(r.accept('host-a', parseHostPush(push({ seq: 1, accounts: [account()] }))).alerts, [], 'a forecast run-out is not an alert');
  const first = r.accept('host-a', parseHostPush(push({ seq: 2, accounts: [hit] })));
  assert.deepEqual(first.alerts, ['Claude · team-a (a@example.com): 5h exhausted · resets in 3h 0m']);
  assert.deepEqual(r.accept('host-b', parseHostPush(push({ seq: 1, accounts: [hit] }))).alerts, [], 'the same condition from another host');
  assert.deepEqual(r.accept('host-a', parseHostPush(push({ seq: 3, accounts: [hit] }))).alerts, [], 'an unchanged condition alerts once');
  const fine = { ...account().windows[0], forecast: { atReset: 80, eta: null, short: false } };
  assert.deepEqual(r.accept('host-a', parseHostPush(push({ seq: 4, accounts: [account({ windows: [fine] })] }))).alerts, [], 'recovering is quiet');
  assert.equal(r.accept('host-a', parseHostPush(push({ seq: 5, accounts: [hit] }))).alerts.length, 1, 'a relapse alerts again');
  const extra = r.accept('host-a', parseHostPush(push({ seq: 6, accounts: [account({ problems: ['wrong team, expected a@example.com · Team A'], extraReset: { at: NOW + HR, url: 'https://x.test/r' } })] })));
  assert.deepEqual(extra.alerts, ['Claude · team-a (a@example.com): wrong team, expected a@example.com · Team A',
    'Claude · team-a (a@example.com): extra reset announced · in 1h 0m · https://x.test/r']);
});

test('alert texts: exhausted only; a forecast run-out and a healthy account say nothing', () => {
  const q = (over) => quotaView(account(over), NOW);
  assert.deepEqual(quotaAlertsFor(undefined, q({ windows: [{ ...account().windows[0], used: 100, forecast: null }] }), NOW).texts,
    ['Claude · team-a (a@example.com): 5h exhausted · resets in 3h 0m']);
  assert.deepEqual(quotaAlertsFor(undefined, q({ windows: [{ ...account().windows[0], forecast: { atReset: 70, eta: null, short: false } }] }), NOW).texts, []);
  assert.deepEqual(quotaAlertsFor(undefined, q(), NOW).texts, [], 'runs out before reset: shown, not alerted');
});

test('a restart keeps the events and what was alerted: no history lost, no duplicate alert', () => {
  const kv = new Map();
  const store = { get: (k) => kv.get(k), put: (k, v) => kv.set(k, structuredClone(v)) };
  const hit = account({ windows: [{ ...account().windows[0], used: 100, forecast: null }] });
  const r1 = new Registry({ hosts: ['host-a'], ttlMs: 60000, now: () => NOW, store });
  assert.equal(r1.accept('host-a', parseHostPush(push({ seq: 1, accounts: [hit] }))).alerts.length, 1);
  const r2 = new Registry({ hosts: ['host-a'], ttlMs: 60000, now: () => NOW, store });
  assert.equal(r2.snapshot().events.length, 1, 'history survives');
  assert.deepEqual(r2.accept('host-a', parseHostPush(push({ seq: 1, accounts: [hit] }))).alerts, [], 'the standing condition does not alert again');
});

test('events: every alert is kept as history for the dashboard, newest first, bounded', async () => {
  const { MAX_EVENTS } = await import('./registry.mjs');
  let t = NOW;
  const r = new Registry({ hosts: ['host-a'], ttlMs: 60000, now: () => t });
  const hit = account({ windows: [{ ...account().windows[0], used: 100, forecast: null }] });
  r.accept('host-a', parseHostPush(push({ seq: 1, accounts: [hit] })));
  const fine = { ...account().windows[0], forecast: { atReset: 80, eta: null, short: false } };
  r.accept('host-a', parseHostPush(push({ seq: 2, accounts: [account({ windows: [fine] })] })));
  t += 60000;
  r.accept('host-a', parseHostPush(push({ seq: 3, accounts: [hit] })));
  const { events } = r.snapshot();
  assert.deepEqual(events.map((e) => e.text.replace(/^.*: /, '')), ['5h exhausted · resets in 2h 59m', '5h exhausted · resets in 3h 0m']);
  assert.equal(events[0].at, new Date(NOW + 60000).toISOString());
  for (let i = 0; i < MAX_EVENTS + 5; i++) {
    r.accept('host-a', parseHostPush(push({ seq: 4 + 2 * i, accounts: [account({ windows: [fine] })] })));
    r.accept('host-a', parseHostPush(push({ seq: 5 + 2 * i, accounts: [hit] })));
  }
  assert.equal(r.snapshot().events.length, MAX_EVENTS);
});

test('view: quota by host — each host with the accounts it runs; a shared account says where else it runs', () => {
  const by = quotaByHost(mockDashboard(NOW), NOW);
  assert.deepEqual(by.map((h) => [h.id, h.accounts.map((q) => `${q.key}+${q.sharedWith.join(',')}`)]),
    [['host-a', ['claude:a+host-c', 'codex:b+host-b']], ['host-b', ['codex:b+host-a']], ['host-c', ['claude:a+host-a']]],
    'online hosts first; one budget, never a second card without saying so');
  assert.deepEqual(by[0].accounts.map(accountTag), ['team-a', 'bob'], 'seat alias, else the email name');
});

test('view: trend ticks in local time — hours for a 5h window, weekday and date for 7d', () => {
  const reset = new Date(2026, 9, 18, 16, 30).getTime();   // local 16:30
  const five = timeTicks({ resetsAt: reset, windowMs: 5 * HR }, reset - 2 * HR);
  assert.deepEqual(five.ticks.map((t) => t.label), ['12', '13', '14', '15', '16'], 'every full hour from the 11:30 opening');
  assert.equal(five.ticks[0].pos, 0.1);
  assert.equal(five.now, 0.6, 'the present sits 3h into 5h');
  const week = timeTicks({ resetsAt: reset, windowMs: 168 * HR }, reset);
  assert.deepEqual(week.ticks.map((t) => t.label), ['Mon 12', 'Tue 13', 'Wed 14', 'Thu 15', 'Fri 16', 'Sat 17', 'Sun 18'], 'every local midnight');
  assert.ok(week.ticks.every((t, i, a) => t.pos > 0 && t.pos < 1 && (!i || t.pos > a[i - 1].pos)));
  assert.equal(timeTicks({ resetsAt: null, windowMs: 5 * HR }).ticks.length, 0, 'a new window has no axis yet');
  assert.equal(timeTicks({ resetsAt: reset, windowMs: 5 * HR }, reset + 1).now, null);
});

test('view: a quota window keeps its length, so the page can draw its time axis', () => {
  const [w] = quotaView(account(), NOW).windows;
  assert.equal(w.windowMs, 5 * HR);
  assert.ok(timeTicks(w, NOW).ticks.length > 0);
});

test('config: only CONFIG_KEYS are editable — never permissions, routing or secrets', async () => {
  const { parseConfigChange } = await import('../shared/dashboard-schema.mjs');
  assert.deepEqual(parseConfigChange({ key: 'bridge.idleCloseMinutes', value: 45 }), { key: 'bridge.idleCloseMinutes', value: 45 });
  assert.deepEqual(parseConfigChange({ key: 'bridge.projects.my-repo.projectInTitle', value: 'main' }), { key: 'bridge.projects.my-repo.projectInTitle', value: 'main' });
  for (const bad of [{ key: 'bridge.allowedUserIds', value: [1] }, { key: 'bridge.approvalsFromTelegram', value: true },
    { key: 'bridge.projects.r.chatId', value: -100 }, { key: 'bridge.botToken', value: 'x' }, { key: 'bridge.dashboard.url', value: 'https://evil' },
    { key: 'bridge.idleCloseMinutes', value: -1 }, { key: 'bridge.idleCloseMinutes', value: '30' }, { key: 'bridge.dashboard.everySeconds', value: 1 },
    { key: 'bridge.projects.*.projectInTitle', value: 'main' }, { key: 'bridge.projects.a.b.projectInTitle', value: 'main' }, { key: '__proto__.x', value: 1 }]) {
    assert.equal(parseConfigChange(bad), null, JSON.stringify(bad));
  }
});

test('config: a change is queued, handed to one host, retried elsewhere if unreported, and its outcome is an event', () => {
  let t = NOW;
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => t });
  const id = r.requestChange({ key: 'bridge.idleCloseMinutes', value: 45 }, ALICE);
  assert.equal(r.snapshot().configPending[0].host, null);
  const a = r.accept('host-a', parseHostPush(push({ seq: 1 })));
  assert.deepEqual(a.configChanges, [{ id, key: 'bridge.idleCloseMinutes', value: 45 }]);
  assert.deepEqual(r.accept('host-b', parseHostPush(push({ seq: 1 }))).configChanges, [], 'one host at a time');
  assert.deepEqual(r.accept('host-a', parseHostPush(push({ seq: 2 }))).configChanges, [], 'not handed twice while awaited');
  t += 121000;
  assert.equal(r.accept('host-b', parseHostPush(push({ seq: 2 }))).configChanges.length, 1, 'unreported: the next host takes it');
  r.accept('host-a', parseHostPush(push({ seq: 3, configResults: [{ id, ok: true }] })));
  assert.equal(r.snapshot().configPending.length, 1, 'a report from a host no longer holding it is ignored');
  r.accept('host-b', parseHostPush(push({ seq: 3, configResults: [{ id, ok: true }] })));
  assert.deepEqual(r.snapshot().configPending, []);
  assert.match(r.snapshot().events[0].text, /^config bridge\.idleCloseMinutes = 45 applied by host-b$/);
  r.requestChange({ key: 'bridge.idleCloseMinutes', value: 10 }, ALICE);
  r.requestChange({ key: 'bridge.idleCloseMinutes', value: 20 }, ALICE);
  assert.deepEqual(r.snapshot().configPending.map((c) => c.value), [20], 'a newer request for a key replaces the older');
});

test('config api: the one write needs a signed allowlisted viewer and an editable key', async () => {
  const g = await gateway();
  const post = async (body, user = ALICE) => g.req('/api/config', { method: 'POST', headers: { ...(await asViewer(user)).headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await g.req('/api/config', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await post({ key: 'bridge.idleCloseMinutes', value: 45 }, MALLORY)).status, 403);
  assert.equal((await post({ key: 'bridge.allowedUserIds', value: [MALLORY] })).status, 400);
  const ok = await post({ key: 'bridge.idleCloseMinutes', value: 45 });
  assert.equal(ok.status, 202);
  assert.ok((await ok.json()).id);
  assert.equal((await g.req('/api/dashboard', { method: 'POST', headers: (await asViewer(ALICE)).headers })).status, 404, 'no other write');
});

test('view: config rows — the freshest value, hosts still syncing or overriding locally, and pending edits', async () => {
  const { configKeysMeta } = await import('../shared/dashboard-schema.mjs');
  const m = mockDashboard(NOW);
  assert.deepEqual(m.configKeys, configKeysMeta(), 'the mock carries the real table');
  const v = configView(m);
  const row = (k) => v.rows.find((r) => r.key === k);
  assert.equal(row('bridge.projects.backend-api.projectInTitle').meta.options.length, 3, 'a project key finds its * entry');
  assert.deepEqual(row('bridge.dashboard.everySeconds').overrides, ['host-b']);
  assert.equal(row('bridge.deleteClosedAfterHours').pending.value, 48);
  assert.deepEqual(v.hosts.map((h) => h.id), ['host-a', 'host-b'], 'hosts that reported a config, online first');
  const syncing = configView({ ...m, hosts: m.hosts.map((h) => (h.id === 'host-b' ? { ...h, config: { ...h.config, editable: { ...h.config.editable, 'bridge.idleCloseMinutes': 10 } } } : h)) });
  assert.deepEqual(syncing.rows.find((r) => r.key === 'bridge.idleCloseMinutes').differs, [{ host: 'host-b', value: 10 }]);
});

test('end to end: a dashboard edit reaches the shared settings through a host push, and comes back as an event', async () => {
  const fs2 = await import('fs'); const os2 = await import('os'); const path2 = await import('path');
  const { DashboardPush } = await import('../bridge/dashboard-push.mjs');
  const { applyConfigChange } = await import('../bridge/context.mjs');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'dash-e2e-'));
  try {
    const sharedPath = path2.join(dir, 's.json');
    fs2.writeFileSync(sharedPath, JSON.stringify({ bridge: { idleCloseMinutes: 30, allowedUserIds: [1] } }));
    const g = await gateway();
    const res = await g.req('/api/config', { method: 'POST', headers: { ...(await asViewer(ALICE)).headers, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'bridge.idleCloseMinutes', value: 45 }) });
    assert.equal(res.status, 202);
    const push = new DashboardPush({ url: 'https://dashboard.example', hostToken: g.token, machine: 'host-a', sessions: () => [], config: () => null,
      onConfigChanges: (changes) => changes.map((c) => ({ id: c.id, ...applyConfigChange(c, { sharedPath }) })),
      fetch: (url, init) => g.api(new Request(url, init)) });
    assert.equal(await push.tick(), true);
    assert.equal(JSON.parse(fs2.readFileSync(sharedPath, 'utf8')).bridge.idleCloseMinutes, 45, 'written by the host');
    assert.equal(await push.tick(), true);
    const snap = await (await g.req('/api/dashboard', await asViewer(ALICE))).json();
    assert.deepEqual(snap.configPending, []);
    assert.match(snap.events[0].text, /^config bridge\.idleCloseMinutes = 45 applied by host-a$/);
    assert.deepEqual(JSON.parse(fs2.readFileSync(sharedPath, 'utf8')).bridge.allowedUserIds, [1], 'nothing else touched');
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});

test('view: demo masking — every identity replaced by rule, stable across polls, structure and numbers kept', () => {
  const real = {
    schemaVersion: 1, generatedAt: 'x', hosts: [
      { id: 'DESK', online: true, config: { editable: { 'bridge.projects.acme-app.projectInTitle': 'always', 'bridge.idleCloseMinutes': 30 }, localOverrides: [], facts: { dashboardError: 'DESK push failed' } },
        sessions: [{ id: '0b6c4e1a-9f', hostId: 'DESK', agent: 'claude', project: 'acme-app', branch: 'fix/x', seat: 'zed',
          account: 'claude:me@corp.example.com|org-1', status: 'working', topic: { url: 'https://t.me/c/5550001234/12', closed: false } }] },
      { id: 'LAPTOP', online: false, sessions: [{ id: 's2', hostId: 'LAPTOP', agent: 'codex', project: 'acme-lib', branch: 'main', seat: null, account: 'codex:x@other.example.com', status: 'idle', topic: null }] }],
    accounts: [
      { key: 'claude:me@corp.example.com|org-1', agent: 'claude', label: 'zed', email: 'me@corp.example.com', detail: 'Zed Lab · Team Premium',
        problems: ['wrong account, expected me@corp.example.com · Zed Lab'], hosts: ['DESK', 'LAPTOP'], windows: [{ k: '5h', used: 26 }] },
      { key: 'codex:x@other.example.com', agent: 'codex', label: null, email: 'x@other.example.com', detail: 'Pro', problems: [], hosts: ['LAPTOP'], windows: [] }],
    events: [{ at: 1, text: 'Claude · zed (me@corp.example.com): 7d runs out, seen on DESK' },
      { at: 2, text: 'config bridge.projects.acme-lib.projectInTitle = "never" refused by DESK: session 0b6c4e1a busy' }],
    configPending: [{ id: 'c1', key: 'bridge.projects.acme-app.projectInTitle', value: 'never', host: 'DESK' }],
  };
  const mask = demoMasker();
  const d = mask(real);
  const s = JSON.stringify(d);
  for (const leak of ['DESK', 'LAPTOP', 'zed', 'Zed Lab', 'corp.example', 'other.example', 'acme-app', 'acme-lib', 'fix/x', '0b6c4e1a', '5550001234', 'org-1'])
    assert.ok(!s.includes(leak), `no ${leak}`);
  assert.deepEqual(d.hosts.map((h) => h.id), ['Workstation 1', 'Workstation 2']);
  const [a, b] = d.hosts.map((h) => h.sessions[0]);
  assert.equal(a.hostId, 'Workstation 1');
  assert.equal(a.seat, 'team-a');
  assert.equal(a.project, 'project-a');
  assert.equal(a.branch, 'branch-1');
  assert.equal(b.branch, 'main', 'main is kept');
  assert.equal(a.account, d.accounts[0].key, 'session still finds its account');
  assert.equal(a.topic.url, 'https://t.me/c/1000000001/12', 'Topic number kept');
  assert.equal(d.accounts[0].label, 'team-a');
  assert.equal(d.accounts[0].email, 'user1@example.com');
  assert.equal(d.accounts[0].detail, 'Team A · Team Premium');
  assert.equal(d.accounts[1].email, 'user2@example.com');
  assert.equal(d.accounts[1].detail, 'Pro', 'plan kept');
  assert.deepEqual(d.accounts[0].hosts, ['Workstation 1', 'Workstation 2']);
  assert.equal(d.accounts[0].problems[0], 'wrong account, expected user1@example.com · Team A');
  assert.equal(d.events[0].text, 'Claude · team-a (user1@example.com): 7d runs out, seen on Workstation 1');
  assert.equal(d.events[1].text, 'config bridge.projects.project-b.projectInTitle = "never" refused by Workstation 1: session session-3 busy', 'config keys and id prefixes in text');
  assert.equal(d.hosts[0].config.facts.dashboardError, 'Workstation 1 push failed');
  assert.ok('bridge.projects.project-a.projectInTitle' in d.hosts[0].config.editable);
  assert.equal(d.configPending[0].key, 'bridge.projects.project-a.projectInTitle');
  assert.equal(d.configPending[0].host, 'Workstation 1');
  assert.equal(d.accounts[0].windows[0].used, 26, 'numbers kept');
  assert.equal(d.demo, true);
  // Next poll lists hosts in another order: names stay with their machine.
  const again = mask({ ...real, hosts: [...real.hosts].reverse() });
  assert.deepEqual(again.hosts.map((h) => h.id), ['Workstation 2', 'Workstation 1']);
  assert.equal(real.hosts[0].id, 'DESK', 'input untouched');
});

test('demo masking: free text by template — names only in text are masked, short names corrupt nothing', () => {
  const mask = demoMasker();
  const d = mask({ hosts: [{ id: 'X', sessions: [] }], accounts: [{ key: 'claude:k', agent: 'claude', label: 'p', email: null, detail: null,
    problems: ['wrong team, expected solo@corp.example.com · Quiet Org'], hosts: ['X'] }], events: [
    { at: 1, text: 'Claude · p (solo@corp.example.com): 5h exhausted · resets in 2h 0m' },
    { at: 2, text: 'Claude · ghost (ghost@corp.example.com): no subscription login, expected not logged in' },
    { at: 3, text: 'config bridge.projects.hidden-app.projectInTitle = "main" applied by OTHERBOX' },
    { at: 4, text: 'config bridge.idleCloseMinutes = 10 refused by X: X said p is busy' },
    { at: 5, text: 'config bridge.idleCloseMinutes = 10 requested' }] });
  assert.equal(d.accounts[0].problems[0], 'wrong team, expected user1@example.com · Team B', 'an org seen only in text gets its own team');
  assert.equal(d.events[0].text, 'Claude · team-a (user1@example.com): 5h exhausted · resets in 2h 0m', '"p" is not replaced inside words');
  assert.equal(d.events[1].text, 'Claude · team-c (user2@example.com): no subscription login, expected not logged in', 'a seat only in text');
  assert.equal(d.events[2].text, 'config bridge.projects.project-a.projectInTitle = "main" applied by Workstation 2', 'a host only in text');
  assert.equal(d.events[3].text, 'config bridge.idleCloseMinutes = 10 refused by Workstation 1: Workstation 1 said team-a is busy');
  assert.equal(d.events[4].text, 'config bridge.idleCloseMinutes = 10 requested');
});

test('view: verdictText takes options — the reset is appended unless `withReset: false`', () => {
  const q = quotaView({ key: 'k', agent: 'codex', problems: [], at: NOW, windows: [{ k: '5h', used: 100, resetsAt: NOW + 3 * HR, windowMs: 5 * HR, cells: [] }] }, NOW);
  assert.equal(verdictText(q, { now: NOW }), '5h exhausted · resets in 3h 0m');
  assert.equal(verdictText(q, { now: NOW, withReset: false }), '5h exhausted');
  assert.equal(verdictText({ ...q, verdict: 'ok' }, { now: NOW }), '');
});

test('view: resetText — a countdown only while the reset is ahead, never `0m`', () => {
  assert.equal(resetText({ resetsAt: NOW + 90 * 60000 }, NOW), '↻ 1h 30m');
  assert.equal(resetText({ resetsAt: NOW - 1000 }, NOW), '');
  assert.equal(resetText({ resetsAt: null }, NOW), '');
  assert.equal(resetText({ renewed: true, resetsAt: null }, NOW), '');
});

test('view: windowLabel — every number is % left; unused and stale read plainly', () => {
  assert.deepEqual(windowLabel({ used: 26, renewed: false }, false), { text: '74%', title: '74% left', stale: false });
  assert.deepEqual(windowLabel({ used: 26, renewed: false }, true), { text: '≤74%', title: 'at most 74% left (stale reading)', stale: true });
  assert.deepEqual(windowLabel({ used: 100, renewed: false }, true), { text: '0%', title: '0% left', stale: false }, 'exhausted stays exhausted');
  assert.deepEqual(windowLabel({ used: 26, renewed: false }, true, 'used'), { text: '≥26%', title: 'at least 26% used (stale reading)', stale: true }, 'the used unit');
  assert.deepEqual([amount(26), amount(26, 'used'), amount(130), amount(130, 'used')], [74, 26, 0, 100]);
  assert.deepEqual(windowLabel({ used: 0, renewed: true }, false), { text: 'unused', title: 'new window, nothing spent yet', stale: false });
  assert.equal(emailName('alice@example.com'), 'alice');
  assert.equal(emailName(null), null);
});

test('view: best account now — per agent the most left on its binding window, exhausted ignored', () => {
  const by = quotaByHost(mockDashboard(NOW), NOW);
  assert.deepEqual(bestAccounts(by[0].accounts).map((b) => [b.agent, b.q.key, b.q.left]), [['claude', 'claude:a', 55]],
    'codex:b is exhausted on 5h, so Codex has no best account');
  const a = (key, agent, left, verdict = 'ok') => ({ key, agent, left, verdict });
  assert.deepEqual(bestAccounts([a('x', 'codex', 20), a('y', 'codex', 70), a('z', 'claude', null, 'none'), a('w', 'claude', 0, 'exhausted')])
    .map((b) => b.q.key), ['y']);
});

test('view: a shared account renders fully once — on its first online host — and as a reference elsewhere', () => {
  const by = quotaByHost(mockDashboard(NOW), NOW);
  assert.deepEqual(by.map((h) => [h.id, h.accounts.map((q) => `${q.key}${q.refTo ? `>${q.refTo}` : ''}`)]),
    [['host-a', ['claude:a', 'codex:b']], ['host-b', ['codex:b>host-a']], ['host-c', ['claude:a>host-a']]]);
  const off = mockDashboard(NOW);
  off.hosts[0].online = false;
  const by2 = quotaByHost(off, NOW);
  assert.equal(by2.find((h) => h.id === 'host-b').accounts[0].refTo, null, 'the first online host owns the card');
  assert.equal(by2.find((h) => h.id === 'host-a').accounts.find((q) => q.key === 'codex:b').refTo, 'host-b');
  assert.equal(by2.find((h) => h.id === 'host-a').accounts.find((q) => q.key === 'claude:a').refTo, null, 'no online host: the first in order');
});

test('api: health reports the deployed version from Cloudflare version metadata', async () => {
  const api = createApi(parseDashboardConfig({ botId: BOT_ID, allowedUserIds: [ALICE], hosts: {} }, PUBLIC_KEY),
    { version: { id: 'abcd1234-0000', tag: 'f06a9b3', timestamp: '2026-10-20T21:00:00Z' } });
  assert.deepEqual((await (await api(new Request('https://x/api/health'))).json()).version,
    { commit: 'f06a9b3', id: 'abcd1234-0000', at: '2026-10-20T21:00:00Z' });
});
