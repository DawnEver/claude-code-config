import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { verifyInitData, verifyHostToken, newHostToken } from './auth.mjs';
import { parseHostPush, topicUrl, MAX_SESSIONS } from '../shared/dashboard-schema.mjs';
import { Registry } from './registry.mjs';
import { createApi, parseDashboardConfig } from './api.mjs';
import { dashboardConfigFrom, menuRequest } from './deploy.mjs';
import { ago, applyFilters, attention, displayStatus, filterOptions, mockDashboard, quotaAlerts, quotaAlertsFor, alertKey, unreadEvents, quotaView, stats, tabs, quotaByHost, accountTag, timeTicks, configView } from './public/view.mjs';

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
  assert.deepEqual(await (await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, push()))).json(), { accepted: true, alerts: [], configChanges: [] });

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
  for (const f of ['app.js', 'view.mjs']) {
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
  assert.deepEqual(quotaAlerts({ accounts: [account(), hit()] }, NOW).map((x) => x.key), ['k2'], 'only a hit limit, not a forecast run-out');
  const [read] = quotaAlerts({ accounts: [hit()] }, NOW);
  assert.deepEqual(quotaAlerts({ accounts: [hit()] }, NOW, [alertKey(read)]), [], 'a read alert leaves the card');
  const next = hit({ resetsAt: account().windows[0].resetsAt + 5 * HR });
  assert.equal(quotaAlerts({ accounts: [next] }, NOW, [alertKey(read)]).length, 1, 'a new window period is a new alert');
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
