import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { verifyInitData, verifyHostToken, newHostToken } from './auth.mjs';
import { parseHostPush, topicUrl, MAX_SESSIONS } from '../shared/dashboard-schema.mjs';
import { WAITING_MAX } from './public/shared/vocab.mjs';
import { Registry, FORGE_EVERY_MS, FORGE_FORGET_MS, FORGE_LEASE_MS } from './registry.mjs';
import { createApi, parseDashboardConfig, REPORT_TTL_MS } from './api.mjs';
import { dashboardConfigFrom, menuRequest } from './deploy.mjs';
import { demoMasker } from './public/demo.mjs';
import { mockDashboard } from './public/mock.mjs';
import { quotaAlertsFor } from './public/shared/quota-model.mjs';
import { alertText, telegramNotifier, ALERT_KINDS } from './notify.mjs';
import { accountSessions, codeView, ago, applyFilters, attention, displayStatus, filterOptions, quotaAlerts, alertKey, quotaView, stats, tabs, taskView, taskLines, searchAll, sessionAccountLabel, hostsView, accountTag, timeTicks, stateAge, groupSessions, configView, verdictText, resetText, windowLabel, bestAccounts, emailName, amount, formatTime } from './public/view.mjs';

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
  const p = parseHostPush(push({ sessions: [session({ cwd: '/home/u/x', token: 'secret' }), session({ id: 's2', topic: null }),
    session({ id: 's3', status: 'bogus' }), session({ id: 's4', status: 'unknown' }), session({ agent: 'gpt' }), session()] }));
  assert.equal(p.sessions.length, 2, 'unknown agent, unknown state and duplicate dropped');
  assert.deepEqual(Object.keys(p.sessions[0]).sort(), ['account', 'agent', 'branch', 'id', 'lastActivityAt', 'lastPostAt', 'mention', 'name', 'posted', 'project', 'provider', 'repo', 'seat', 'status', 'topic', 'unread']);
  assert.deepEqual(p.sessions[0].topic, { url: 'https://t.me/c/1234567890/77', closed: false });
  assert.equal(p.sessions[1].topic, null);
  assert.equal(topicUrl(-999, 5), null, 'not a supergroup');
  assert.equal(topicUrl(-1001, 0), null);
  assert.equal(topicUrl(-1001234567890, 77, 90), 'https://t.me/c/1234567890/77/90');
  const at = parseHostPush(push({ sessions: [session({ posted: 4, lastPostAt: new Date(NOW).toISOString(),
    topic: { chatId: -1001234567890, topicId: 77, closed: false, firstUnread: 88, lastPost: 90 } })] })).sessions[0];
  assert.deepEqual(at.topic, { url: 'https://t.me/c/1234567890/77', closed: false,
    firstUnreadUrl: 'https://t.me/c/1234567890/77/88', latestUrl: 'https://t.me/c/1234567890/77/90' });
  assert.deepEqual([at.posted, at.lastPostAt], [4, new Date(NOW).toISOString()]);
  assert.equal(parseHostPush(push({ schemaVersion: 2 })), null);
  assert.equal(parseHostPush(push({ seq: 0 })), null);
  assert.equal(parseHostPush({ ...push(), sessions: Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => session({ id: `s${i}` })) }).sessions.length, MAX_SESSIONS);
});

test('registry: ordering per boot, offline after TTL, configured hosts listed before their first push', () => {
  let t = NOW;
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => t });
  assert.deepEqual(r.host('host-b'), { id: 'host-b', online: false, lastSeen: null, sessions: [], resources: null, config: null });
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

async function gateway(over = {}, { db = null } = {}) {
  const { token, hash } = await newHostToken();
  let now = NOW;
  const api = createApi(parseDashboardConfig({ botId: BOT_ID, allowedUserIds: [ALICE], hosts: { 'host-a': hash }, ratePerMinute: 1000, ...over }, PUBLIC_KEY),
    { now: () => now, db });
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
  assert.deepEqual(await (await g.req('/api/hosts/host-a/snapshot', hostPost(g.token, push()))).json(), { accepted: true, configChanges: [], forgeRead: [] });

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
  assert.equal((await g.req('/api/hosts/%E0%A4%A/sessions', await asViewer(ALICE))).status, 404, 'no per-host read endpoint; a malformed escape is no 500');
  assert.equal((await g.req('/api/hosts/%E0%A4%A/snapshot', hostPost(g.token, push()))).status, 401);
  assert.equal((await g.req('/api/dashboard')).status, 401);
  g.tick(181000);
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

test('style: tokens only in :root, every class in use, inline styles only for geometry', () => {
  const dir = new URL('./public/', import.meta.url);
  const html = fs.readFileSync(new URL('index.html', dir), 'utf8');
  const app = fs.readFileSync(new URL('app.js', dir), 'utf8');
  const code = app + fs.readFileSync(new URL('view.mjs', dir), 'utf8') + html.slice(html.indexOf('</style>'));
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(css.match(/:root\s*\{/g)?.length, 1, 'one :root holds every token');
  const body = css.replace(/:root\s*\{[^}]*\}/, '');
  for (const [, prop, value] of body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const at = `${prop}: ${value.trim()}`;
    assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i, `colour literal outside :root — ${at}`);
    if (/^(font|font-size|border-radius|gap|row-gap|column-gap)$|^(margin|padding)/.test(prop)) assert.doesNotMatch(value, /\d(px|rem|em)\b/, `size literal outside :root — ${at}`);
  }
  const used = new Set(code.match(/[\w-]+/g));
  const dynamic = ['s-', 'k-', 'b-', 'v-', 'ci-'].filter((p) => code.includes(`${p}\${`));
  for (const [, c] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    assert.ok(used.has(c) || dynamic.some((p) => c.startsWith(p)), `.${c} is styled but no code uses it`);
  }
  for (const [, prop] of app.matchAll(/\.style\.([a-zA-Z]+)/g)) assert.match(prop, /^(width|height|left|setProperty)$/, `inline style ${prop}: geometry only`);
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
  const { STATUS_CODES } = await import('../bridge/daemon.mjs');
  const { STATUSES } = await import('../shared/dashboard-schema.mjs');
  const { DISPLAY_STATUSES } = await import('./public/view.mjs');
  assert.deepEqual([...new Set(Object.values(STATUS_CODES))].sort(), [...STATUSES].sort(), 'every native state maps onto the vocabulary, and covers it');
  assert.deepEqual([...DISPLAY_STATUSES].sort(), [...STATUSES, 'stale'].sort(), 'the page adds only freshness');
});

test('the vocabulary is defined once: no status label, agent name or stale threshold copied elsewhere', () => {
  const files = ['../bridge/daemon.mjs', '../bridge/quota.mjs', '../shared/dashboard-schema.mjs', './public/view.mjs', './public/app.js', './registry.mjs']
    .map((f) => [f, fs.readFileSync(new URL(f, import.meta.url), 'utf8')]);
  for (const [f, src] of files) {
    assert.doesNotMatch(src, /'Needs approval'|'Needs input'|15 \* 60000|=== 'claude' \? 'Claude'/, `${f} restates the vocabulary`);
  }
});

test('view: needs-you first, stale is freshness, chips narrow, hosts online first', () => {
  const f = mockDashboard(NOW);
  const all = { group: 'all', host: '', agent: '', project: '' };
  assert.equal(displayStatus(f.hosts[2].sessions[0]), 'stale');
  assert.deepEqual(stats(f), { hostsOnline: 2, hosts: 3, working: 2, attention: 1 });
  assert.deepEqual(attention(f).map((s) => s.project), ['frontend'], 'live sessions waiting for the human');
  assert.deepEqual(filterOptions(f).counts, { all: 5, attention: 1, working: 2, idle: 1, stale: 1 });
  assert.deepEqual(applyFilters(hostsView(f, NOW), all)[0].sessions.map((s) => s.status), ['needs_approval', 'working'], 'most urgent first');
  assert.deepEqual(applyFilters(hostsView(f, NOW), all).map((h) => h.id), ['host-a', 'host-b', 'host-c'], 'offline host last');
  assert.deepEqual(applyFilters(hostsView(f, NOW), { ...all, agent: 'codex' }).map((h) => h.sessions.length), [1, 1]);
  assert.deepEqual(applyFilters(hostsView(f, NOW), { ...all, group: 'attention' }).map((h) => h.id), ['host-a']);
  assert.deepEqual(applyFilters(hostsView(f, NOW), { ...all, group: 'stale', project: 'backend-api' }).map((h) => h.id), ['host-c']);
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
    sessions: () => bridge.dashboardSessions(), fetch: (url, init) => g.api(new Request(url, init)) });
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
  assert.deepEqual(quotaAlerts({ accounts: [account(), hit()] }, NOW).map((x) => x.key), ['k2'], 'a hit limit; a forecast run-out is only shown');
  const soon = account({ key: 'k3', windows: [{ ...account().windows[0], forecast: { atReset: 150, eta: NOW + 0.5 * HR, short: true } }] });
  assert.deepEqual(quotaAlerts({ accounts: [soon] }, NOW), [], 'even a run-out within the hour is never an alert');
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
  const hosts = applyFilters(hostsView(mockDashboard(NOW), NOW), {});
  assert.equal(groupSessions(hosts, 'host'), hosts);
  const g = groupSessions(hosts, 'project');
  assert.deepEqual(g.map((x) => x.id), [...new Set(hosts.flatMap((h) => h.sessions.map((s) => s.project ?? 'unknown project')))].sort());
  assert.equal(g.reduce((n, x) => n + x.sessions.length, 0), hosts.reduce((n, h) => n + h.sessions.length, 0), 'every session once');
  assert.equal(groupSessions([{ id: 'h', online: false, sessions: [{ project: 'p', status: 'idle' }] }, { id: 'i', online: true, sessions: [{ project: 'p', status: 'needs_input' }] }], 'project', 'urgency')[0].sessions[0].status,
    'needs_input', 'by urgency: the most urgent first across hosts');
  assert.deepEqual(groupSessions([{ id: 'h', online: true, sessions: [{ project: 'p', status: 'idle' }] }, { id: 'i', online: true, sessions: [{ project: 'p', status: 'needs_input' }] }], 'project')[0].sessions.map((s) => s.hostId),
    ['h', 'i'], 'by default: sorted by workstation inside a project');
});

test('view: tabs count each view and flag quota that needs the human; no accounts, no tabs', () => {
  const m = mockDashboard(NOW);
  assert.deepEqual(tabs(m, NOW), { sessions: 5, quota: 3, alert: true });
  assert.equal(tabs(m, NOW, quotaAlerts(m, NOW).map(alertKey)).alert, false, 'read alerts do not flag the quota tab');
  assert.deepEqual(tabs({ hosts: [] }, NOW), { sessions: 0, quota: 0, alert: false });
});

/** A registry whose alerts are collected in `sent`, as data. */
function alerting(opts = {}) {
  const sent = [];
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => NOW, ...opts, notify: (a) => { sent.push(a); } });
  return { r, sent };
}
/** What `f` sent, in words as of NOW. */
const added = (sent, f) => { const before = sent.length; f(); return sent.slice(before).map((a) => alertText(a, NOW)); };

test('alerts: a change once, judged on the merged account, so two hosts on one seat alert once', () => {
  const { r, sent } = alerting();
  const hit = account({ windows: [{ ...account().windows[0], used: 100, forecast: null }] });
  const accept = (host, seq, a) => () => r.accept(host, parseHostPush(push({ seq, accounts: [a] })));
  assert.deepEqual(added(sent, accept('host-a', 1, account())), [], 'a forecast run-out is not an alert');
  assert.deepEqual(added(sent, accept('host-a', 2, hit)), ['Quota exhausted: Claude · team-a · a@example.com\n5h window · resets in 3h 0m']);
  assert.deepEqual(added(sent, accept('host-b', 1, hit)), [], 'the same condition from another host');
  assert.deepEqual(added(sent, accept('host-a', 3, hit)), [], 'an unchanged condition alerts once');
  const fine = { ...account().windows[0], forecast: { atReset: 80, eta: null, short: false } };
  assert.deepEqual(added(sent, accept('host-a', 4, account({ windows: [fine] }))), [], 'recovering is quiet');
  assert.equal(added(sent, accept('host-a', 5, hit)).length, 1, 'a relapse alerts again');
  const extra = account({ problems: ['wrong team, expected a@example.com · Team A'], extraReset: { at: NOW + HR, url: 'https://x.test/r' } });
  assert.deepEqual(added(sent, accept('host-a', 6, extra)), ['Seat problem: Claude · team-a · a@example.com\nwrong team, expected a@example.com · Team A',
    'Extra reset announced: Claude · team-a · a@example.com\nin 1h 0m\nhttps://x.test/r']);
  assert.deepEqual(Object.keys(sent.at(-1)).sort(), ['account', 'at', 'kind', 'url'], 'an alert is data, not a sentence');
  assert.equal('events' in r.snapshot(), false, 'no history is kept: alerts go to the chat');
});

test('alerts: exhausted only; a forecast run-out and a healthy account say nothing', () => {
  const q = (over) => quotaView(account(over), NOW);
  assert.deepEqual(quotaAlertsFor(undefined, q({ windows: [{ ...account().windows[0], used: 100, forecast: null }] })).events,
    [{ kind: 'exhausted', account: { agent: 'claude', label: 'team-a', email: 'a@example.com' }, window: '5h', resetsAt: NOW + 3 * HR }]);
  assert.deepEqual(quotaAlertsFor(undefined, q({ windows: [{ ...account().windows[0], forecast: { atReset: 70, eta: null, short: false } }] })).events, []);
  assert.deepEqual(quotaAlertsFor(undefined, q()).events, [], 'runs out before reset: shown, not alerted');
});

test('every message the bot sends has one shape — heading: subject, then detail, then link — worded on the send clock', () => {
  const e = { kind: 'exhausted', account: { agent: 'codex', label: null, email: 'a@example.com' }, window: '5h', resetsAt: NOW + HR };
  const lines = (...l) => l.join('\n');
  assert.equal(alertText(e, NOW), lines('Quota exhausted: Codex · a@example.com', '5h window · resets in 1h 0m'));
  assert.equal(alertText(e, NOW + 2 * HR), lines('Quota exhausted: Codex · a@example.com', '5h window'), 'a passed reset is not counted down');
  assert.equal(alertText({ kind: 'config-refused', key: 'k', value: 3, host: 'h', error: 'busy' }), lines('Config change refused: k = 3', 'by h: busy'));
  assert.equal(alertText({ kind: 'host-offline', host: 'host-x', lastSeen: new Date(NOW - 6 * 60000).toISOString() }, NOW), lines('Host offline: host-x', 'silent for 6m'));
  assert.equal(alertText({ kind: 'host-offline', host: 'host-x', lastSeen: null }, NOW, 'zh'), lines('主机掉线：host-x', '自 dashboard 重启以来未上报'));
  assert.equal(alertText({ kind: 'turn-failed', host: 'host-x', agent: 'claude', project: 'p', session: 's', error: 'overloaded: 529', url: 'https://t.me/c/1/2' }),
    lines('Turn failed: Claude · host-x · p · s', 'overloaded: 529', 'https://t.me/c/1/2'));
  assert.equal(alertText({ kind: 'extra-reset', account: { agent: 'claude', label: 'team-a' }, at: NOW + HR, url: 'https://x.test/r' }, NOW),
    lines('Extra reset announced: Claude · team-a', 'in 1h 0m', 'https://x.test/r'));
  assert.equal(alertText({ kind: 'test', from: 'host-x' }, NOW, 'zh'), lines('测试：host-x', 'dashboard 的提醒会发到这里。'));
  for (const kind of ALERT_KINDS) for (const lang of ['en', 'zh']) assert.doesNotMatch(alertText({ kind, account: {}, host: 'h' }, NOW, lang), /^alert\./, `${kind} ${lang} has its heading`);
});

test('a restart keeps what was alerted: no duplicate alert; storage is written only on a change', () => {
  const kv = new Map();
  let writes = 0;
  const store = { get: (k) => kv.get(k), put: (k, v) => { writes++; kv.set(k, structuredClone(v)); } };
  const hit = account({ windows: [{ ...account().windows[0], used: 100, forecast: null }] });
  const one = alerting({ store });
  assert.equal(added(one.sent, () => one.r.accept('host-a', parseHostPush(push({ seq: 1, accounts: [hit] })))).length, 1);
  const w = writes;
  one.r.accept('host-a', parseHostPush(push({ seq: 2, accounts: [hit] })));
  assert.equal(writes, w, 'an unchanged condition costs no storage write');
  const two = alerting({ store });
  assert.deepEqual(added(two.sent, () => two.r.accept('host-a', parseHostPush(push({ seq: 1, accounts: [hit] })))), [], 'the standing condition does not alert again');
});

test('offline: a host silent past offlineAlertMs is alerted once; its next push watches it again, silently', () => {
  let t = NOW;
  const kv = new Map();
  const store = { get: (k) => kv.get(k), put: (k, v) => kv.set(k, structuredClone(v)) };
  const { r, sent } = alerting({ now: () => t, offlineAlertMs: 300000, store });
  r.accept('host-a', parseHostPush(push({ seq: 1 })));
  t += 60000;
  r.accept('host-b', parseHostPush(push({ seq: 1 })));
  assert.equal(r.sweep(), NOW + 300000, 'wakes when the first host would turn silent');
  assert.equal(sent.length, 0);
  t = NOW + 300000;
  assert.equal(r.sweep(), NOW + 360000, 'then when the next would');
  assert.deepEqual(sent.map((a) => [a.kind, a.host, a.lastSeen]), [['host-offline', 'host-a', new Date(NOW).toISOString()]]);
  t = NOW + 400000;
  assert.equal(r.sweep(), null, 'every host alerted: nothing to wake for');
  assert.equal(r.sweep(), null);
  assert.equal(sent.length, 2, 'alerted once each');
  const again = alerting({ now: () => t, offlineAlertMs: 300000, store });
  assert.equal(again.r.sweep(), null, 'a restart does not alert a host already alerted');
  assert.equal(again.sent.length, 0);
  t += 60000;
  again.r.accept('host-a', parseHostPush(push({ seq: 2 })));
  assert.deepEqual(again.sent, [], 'coming back is not alerted');
  assert.equal(again.r.sweep(), t + 300000, 'watched again');
});

test('offline: a configured host never heard from since a start is counted from the start', () => {
  let t = NOW;
  const { r, sent } = alerting({ now: () => t, offlineAlertMs: 300000 });
  assert.equal(r.sweep(), NOW + 300000);
  t += 300000;
  r.sweep();
  assert.deepEqual(sent.map((a) => [a.host, a.lastSeen]), [['host-a', null], ['host-b', null]]);
});

test('host alerts: a failed turn is sent once, even when its push is sent again', () => {
  const { r, sent } = alerting();
  const failed = { id: 'f1', kind: 'turn-failed', agent: 'claude', project: 'p', session: 's', error: 'overloaded', url: null };
  r.accept('host-a', parseHostPush(push({ seq: 1, alerts: [failed] })));
  r.accept('host-a', parseHostPush(push({ seq: 2, alerts: [failed] })));
  assert.deepEqual(sent.map((a) => [a.kind, a.host, a.error]), [['turn-failed', 'host-a', 'overloaded']]);
});

test('telegramNotifier: plain text to every allowed chat, resolving those reached; a failure is logged without the token', async () => {
  const calls = [], logs = [];
  const fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { status: 200, json: async () => (calls.length === 1 ? { ok: true } : { ok: false, description: 'Forbidden: bot was blocked by the user' }) }; };
  const notify = telegramNotifier({ token: '1:SECRET', chatIds: [11, 22], fetch, log: (m) => logs.push(m), now: () => NOW });
  assert.deepEqual(await notify({ kind: 'test', from: 'host-x' }), [11]);
  const text = 'Test: host-x\nAlerts from the dashboard reach this chat.';
  assert.deepEqual(calls.map(([, b]) => [b.chat_id, b.text, b.parse_mode]), [[11, text, undefined], [22, text, undefined]]);
  assert.deepEqual(logs, ['alert test to 22 not sent: Forbidden: bot was blocked by the user']);
  assert.ok(!logs.join().includes('SECRET'));
});

test('view: quota by host — each host with the accounts it runs; a shared account says where else it runs', () => {
  const by = hostsView(mockDashboard(NOW), NOW);
  assert.deepEqual(by.map((h) => [h.id, h.accounts.map((q) => `${q.key}+${q.sharedWith.join(',')}`)]),
    [['host-a', ['claude:a+host-c', 'codex:b+host-b']], ['host-b', ['codex:b+host-a', 'api:deepseek:default+']], ['host-c', ['claude:a+host-a']]],
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
  assert.deepEqual(r.snapshot().configLast['bridge.idleCloseMinutes'], { outcome: 'applied', value: 45, host: 'host-b', at: new Date(t).toISOString() });
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
    assert.deepEqual([snap.configLast['bridge.idleCloseMinutes'].outcome, snap.configLast['bridge.idleCloseMinutes'].host], ['applied', 'host-a']);
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
    configLast: { 'bridge.projects.acme-lib.projectInTitle': { at: 2, value: 'never', outcome: 'refused', host: 'DESK', error: 'session 0b6c4e1a busy' } },
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
  assert.deepEqual(d.configLast['bridge.projects.project-b.projectInTitle'], { at: 2, value: 'never', outcome: 'refused', host: 'Workstation 1', error: 'session session-3 busy' },
    'config keys, hosts and id prefixes');
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

test('demo masking: a seat problem by its template — an org seen only in text gets its own team; short names corrupt nothing', () => {
  const mask = demoMasker();
  const d = mask({ hosts: [{ id: 'X', sessions: [] }], accounts: [{ key: 'claude:k', agent: 'claude', label: 'p', email: null, detail: null,
    problems: ['wrong team, expected solo@corp.example.com · Quiet Org'], hosts: ['X'] }],
    configLast: { 'bridge.idleCloseMinutes': { at: 2, value: 10, outcome: 'refused', host: 'X', error: 'X said p is busy' } } });
  assert.equal(d.accounts[0].problems[0], 'wrong team, expected user1@example.com · Team B');
  assert.equal(d.configLast['bridge.idleCloseMinutes'].error, 'Workstation 1 said team-a is busy', '"p" is not replaced inside words');
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
  assert.deepEqual(windowLabel({ used: 0, renewed: true }, false), { text: 'not read', title: 'the window has reset since the last reading; use unknown until the account is used on this host', stale: false });
  assert.equal(emailName('alice@example.com'), 'alice');
  assert.equal(emailName(null), null);
});

test('view: best account now — per agent the most left on its binding window, exhausted ignored', () => {
  const by = hostsView(mockDashboard(NOW), NOW);
  assert.deepEqual(bestAccounts(by[0].accounts).map((b) => [b.agent, b.q.key, b.q.left]), [['claude', 'claude:a', 55]],
    'codex:b is exhausted on 5h, so Codex has no best account');
  const a = (key, agent, left, verdict = 'ok') => ({ key, agent, left, verdict });
  assert.deepEqual(bestAccounts([a('x', 'codex', 20), a('y', 'codex', 70), a('z', 'claude', null, 'none'), a('w', 'claude', 0, 'exhausted')])
    .map((b) => b.q.key), ['y']);
});

test('view: a shared account renders fully once — on its first online host — and as a reference elsewhere', () => {
  const by = hostsView(mockDashboard(NOW), NOW);
  assert.deepEqual(by.map((h) => [h.id, h.accounts.map((q) => `${q.key}${q.refTo ? `>${q.refTo}` : ''}`)]),
    [['host-a', ['claude:a', 'codex:b']], ['host-b', ['codex:b>host-a', 'api:deepseek:default']], ['host-c', ['claude:a>host-a']]]);
  const off = mockDashboard(NOW);
  off.hosts[0].online = false;
  const by2 = hostsView(off, NOW);
  assert.equal(by2.find((h) => h.id === 'host-b').accounts[0].refTo, null, 'the first online host owns the card');
  assert.equal(by2.find((h) => h.id === 'host-a').accounts.find((q) => q.key === 'codex:b').refTo, 'host-b');
  assert.equal(by2.find((h) => h.id === 'host-a').accounts.find((q) => q.key === 'claude:a').refTo, null, 'no online host: the first in order');
});


test('view: formatTime — 24h and a short day by default; 12h, ISO date and no date on request', () => {
  const t = new Date(2026, 9, 21, 23, 36).getTime();
  assert.equal(formatTime(t), '21 Oct 23:36');
  assert.equal(formatTime(t, { clock: '12' }), '21 Oct 11:36 PM');
  assert.equal(formatTime(t, { date: 'iso' }), '2026-10-21 23:36');
  assert.equal(formatTime(new Date(2026, 0, 2, 0, 5).getTime(), { clock: '12', date: 'off' }), '12:05 AM');
});

test('chat list: name over project, Telegram-style time and badges, machine load meters', async () => {
  const v = await import('./public/view.mjs');
  assert.equal(v.sessionLabel({ name: 'Fix login', project: 'p' }), 'Fix login');
  assert.equal(v.sessionLabel({ name: null, project: 'p' }), 'p');
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  assert.equal(v.chatTime(new Date(2026, 9, 22, 9, 5).toISOString(), now), '09:05');
  assert.equal(v.chatTime(new Date(2026, 9, 20, 9, 5).toISOString(), now), 'Tue');
  assert.equal(v.chatTime(new Date(2026, 8, 1).toISOString(), now), '1 Sep');
  assert.deepEqual([0, 5, 120].map(v.unreadBadge), ['', '5', '99+']);
  const topic = { url: 'https://t.me/c/1/7', firstUnreadUrl: 'https://t.me/c/1/7/20', latestUrl: 'https://t.me/c/1/7/24' };
  const s = { unread: 3, posted: 10, topic };
  assert.deepEqual([v.unreadHere(s, undefined), v.unreadHere(s, 8), v.unreadHere(s, 10), v.unreadHere(s, 12)], [3, 2, 0, 3],
    'opened on this device: what was there is read; a count from before a reset is ignored');
  assert.equal(v.topicTarget(s, undefined), topic.latestUrl, 'latest by default');
  assert.equal(v.topicTarget(s, undefined, 'first'), topic.firstUnreadUrl);
  assert.equal(v.topicTarget(s, 8, 'first'), topic.latestUrl, 'the first post still unread here is not known');
  assert.equal(v.topicTarget({ unread: 0, posted: 0, topic: { url: topic.url } }, undefined, 'first'), topic.url);
  assert.equal(v.replyTime({ lastPostAt: new Date(now - 5 * 60000).toISOString() }, now), 'reply 5m ago');
  assert.equal(v.replyTime({ lastPostAt: new Date(2026, 9, 22, 9, 5).toISOString() }, now, 'clock'), 'reply 09:05');
  assert.equal(v.replyTime({ lastPostAt: new Date(2026, 9, 20, 21, 5).toISOString() }, now, 'clock'), 'reply Tue 21:05', 'before today: the day too');
  assert.equal(v.replyTime({ lastPostAt: null }, now), null);
  const GB = 1024 ** 3;
  const r = v.resourceView({ cpu: 40, cores: 32, cpuModel: 'Intel Core i9-13900K', mem: { used: 8 * GB, total: 32 * GB, type: 'DDR5' },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060', util: 1, memUsed: 1.4 * GB, memTotal: 12 * GB }] });
  assert.deepEqual(r.meters.map((m) => [m.label, m.text]), [['CPU', '40%'], ['RAM', '8/32 GB'], ['GPU', '1%'], ['GPU MEM', '1.4/12 GB']],
    'values stay short: they sit beside a bar and must never be cut');
  assert.equal(r.about, 'Intel Core i9-13900K · 32 cores · 32 GB DDR5 · NVIDIA GeForce RTX 3060', 'what the hardware is goes on its own line');
  assert.deepEqual(v.resourceView(null), { meters: [], about: '' });
});

test('view: one host model for every tab — all hosts, one order, accounts attached', async () => {
  const v = await import('./public/view.mjs');
  const snap = mockDashboard(NOW);
  snap.hosts.push({ id: 'host-d', online: true, lastSeen: snap.generatedAt, sessions: [], resources: null });
  const hosts = v.hostsView(snap, NOW);
  assert.deepEqual(hosts.map((h) => h.id), ['host-a', 'host-b', 'host-d', 'host-c'], 'online first, then by name; a host without accounts is listed');
  assert.deepEqual(hosts.find((h) => h.id === 'host-d').accounts, []);
  assert.ok(hosts[0].resources.gpus.length && hosts[0].sessions.length, 'sessions, accounts and load ride the same host object');
});

test('layers: the Worker never imports page presentation; the shared layer imports nothing outside itself', () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const f of ['./registry.mjs', './api.mjs', './worker.mjs', '../shared/dashboard-schema.mjs']) {
    assert.doesNotMatch(read(f), /public\/(view|app|demo|mock)\.m?js/, `${f} imports page presentation`);
  }
  for (const f of fs.readdirSync(new URL('./public/shared/', import.meta.url))) {
    for (const [, spec] of read(`./public/shared/${f}`).matchAll(/from '([^']+)'/g)) assert.match(spec, /^\.\/[\w-]+\.mjs$/, `${f} imports ${spec}`);
  }
});

test('usage report: for an allowlisted viewer, held REPORT_TTL_MS per range so a left-open tab does not reread the store', async () => {
  let reads = 0;
  const db = { prepare: () => ({ bind: () => ({ all: async () => { reads++; return { results: [] }; } }) }) };
  const g = await gateway({}, { db });
  assert.equal((await g.req('/api/usage?days=30', await asViewer(MALLORY))).status, 403);
  assert.equal((await g.req('/api/usage?days=30', await asViewer(ALICE))).status, 200);
  const once = reads;
  await g.req('/api/usage?days=30', await asViewer(ALICE));
  assert.equal(reads, once, 'held');
  await g.req('/api/usage?days=7', await asViewer(ALICE));
  assert.ok(reads > once, 'another range reads');
  const again = reads;
  g.tick(REPORT_TTL_MS);
  await g.req('/api/usage?days=30', await asViewer(ALICE));
  assert.ok(reads > again, 'expired: read again');
});

test('usage report: the filter is part of the held key, in any order; values are bounded', async () => {
  let reads = 0, last = null;
  const db = { prepare: (sql) => ({ bind: (...args) => ({ all: async () => { reads++; last = { sql, args }; return { results: [] }; } }) }) };
  const g = await gateway({}, { db });
  const r = await (await g.req('/api/usage?days=7&model=m2&model=m1&project=', await asViewer(ALICE))).json();
  assert.deepEqual(r.filter, { project: [''], model: ['m1', 'm2'], machine: [] });
  const once = reads;
  await g.req('/api/usage?days=7&model=m1&project=&model=m2', await asViewer(ALICE));
  assert.equal(reads, once, 'the same filter in another order is held');
  await g.req('/api/usage?days=7&model=m1', await asViewer(ALICE));
  assert.ok(reads > once, 'another filter reads');
  const many = Array.from({ length: 30 }, (_, i) => `machine=h${i}`).join('&');
  assert.equal((await g.req(`/api/usage?days=7&${many}`, await asViewer(ALICE))).status, 400, 'an oversized filter is refused, not cut');
  assert.ok(last.sql.includes('?'), 'values are bound, never spliced into SQL');
});

test('accountSessions: the sessions on one account across hosts, most urgent first', () => {
  const snap = { hosts: [
    { id: 'a', sessions: [{ id: '1', account: 'k', status: 'running', project: 'p' }, { id: '2', account: 'x', status: 'running' }] },
    { id: 'b', sessions: [{ id: '3', account: 'k', status: 'waiting', project: 'q' }] }] };
  const got = accountSessions(snap, 'k');
  assert.deepEqual(got.map((s) => [s.id, s.hostId]).sort(), [['1', 'a'], ['3', 'b']]);
  assert.equal(accountSessions(snap, 'none').length, 0);
});

test('i18n: the language defaults from Telegram language_code (zh* -> zh, else en); t() falls back to English, then the key', async () => {
  const { t, defaultLang, LANGS, i18nKeys } = await import('./public/shared/i18n.mjs');
  assert.deepEqual(['zh', 'zh-hans', 'zh-TW', 'ZH'].map(defaultLang), ['zh', 'zh', 'zh', 'zh']);
  assert.deepEqual(['en', 'de', 'ja', '', undefined, null].map(defaultLang), ['en', 'en', 'en', 'en', 'en', 'en']);
  assert.equal(t('tab.config', 'en'), 'Config');
  assert.equal(t('tab.config', 'zh'), '设置');
  assert.equal(t('tab.config', 'fr'), 'Config', 'an unknown language reads English');
  assert.equal(t('no.such.key', 'zh'), 'no.such.key');
  assert.equal(t('sessions.count', 'en', { n: 1 }), '1 session');
  assert.equal(t('sessions.count', 'en', { n: 3 }), '3 sessions');
  assert.equal(t('status.needs_approval', 'zh'), '待批准');
  for (const k of i18nKeys()) for (const l of LANGS) assert.notEqual(t(k, l, {}), k, `${k} has ${l}`);
});

test('i18n: every config key and option, every status and chip has words; view text follows the language', async () => {
  const { t } = await import('./public/shared/i18n.mjs');
  const { CONFIG_KEYS } = await import('./public/shared/config-keys.mjs');
  const { DISPLAY_STATUSES, GROUPS, configLabel } = await import('./public/view.mjs');
  const keys = [...Object.keys(CONFIG_KEYS).map((k) => `config.${k}`), ...Object.values(CONFIG_KEYS).flatMap((s) => (s.options ?? []).map((o) => `config.option.${o}`)),
    ...DISPLAY_STATUSES.map((s) => `status.${s}`), ...Object.keys(GROUPS).map((g) => `group.${g}`)];
  for (const k of keys) assert.notEqual(t(k, 'zh'), k, k);
  assert.equal(configLabel('bridge.projects.api.projectInTitle', 'bridge.projects.*.projectInTitle'), 'Project name in Topic titles · api');
  assert.equal(stateAge({ status: 'idle', lastActivityAt: new Date(NOW - 125 * 60000).toISOString() }, NOW, 'zh'), '空闲 2h');
  assert.equal(ago(new Date(NOW - 3 * 60000).toISOString(), NOW, 'zh'), '3m前');
  assert.equal(formatTime(new Date(2026, 9, 21, 23, 36).getTime(), { lang: 'zh' }), '10月21日 23:36');
});

test('view: config rows sit in their group and read the change flow — queued, handed to a host, then the outcome', () => {
  const m = mockDashboard(NOW);
  const row = (snap, k) => configView(snap).rows.find((r) => r.key === k);
  assert.deepEqual(Object.fromEntries(configView(m).rows.map((r) => [r.key, r.group])), { 'bridge.dashboard.everySeconds': 'dashboard', 'bridge.deleteClosedAfterHours': 'topics',
    'bridge.idleCloseMinutes': 'topics', 'bridge.projects.backend-api.projectInTitle': 'projects' });
  const last = { at: 3, value: 45, outcome: 'refused', host: 'host-b', error: 'read-only' };
  assert.equal(row({ ...m, configLast: { 'bridge.idleCloseMinutes': last } }, 'bridge.idleCloseMinutes').last, last, 'the last outcome a host reported');
  assert.equal(row({ ...m, configLast: {} }, 'bridge.idleCloseMinutes').last, null, 'a request alone is no outcome');
  assert.equal(row(m, 'bridge.deleteClosedAfterHours').pending.host, 'host-a', 'handed to a host');
});

test('removed: one session renderer (chat list), no needs-you card, packed layout fixed', () => {
  const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /chatList|needsYouCard|dashboard\.packed|quotaAlertRow/);
});

test('accounts: a balance two hosts read is one account, the freshest, with both hosts; it sits in a host card like a subscription', () => {
  const r = new Registry({ hosts: ['host-a', 'host-b'], ttlMs: 60000, now: () => 5000 });
  const b = (at, amount) => [{ key: 'api:deepseek:default', kind: 'balance', provider: 'deepseek', at, balances: [{ currency: 'CNY', amount }] }];
  r.accept('host-a', parseHostPush(push({ accounts: b(1.7e12 + 1000, 10) })));
  r.accept('host-b', parseHostPush(push({ accounts: b(1.7e12, 12), sessions: [session({ id: 's1', account: 'api:deepseek:default' })] })));
  const snap = r.snapshot();
  assert.equal(snap.billing, undefined, 'no second list: a balance is an account');
  const [one, ...rest] = snap.accounts;
  assert.equal(rest.length, 0);
  assert.deepEqual([one.balances[0].amount, one.hosts], [10, ['host-a', 'host-b']]);
  const hosts = hostsView(snap, 1.7e12 + 2000);
  assert.deepEqual(hosts.map((h) => [h.id, h.accounts.map((q) => [q.key, q.refTo])]),
    [['host-a', [['api:deepseek:default', null]]], ['host-b', [['api:deepseek:default', 'host-a']]]]);
  assert.deepEqual(accountSessions(snap, 'api:deepseek:default').map((s) => [s.id, s.hostId]), [['s1', 'host-b']]);
  assert.deepEqual(r.alerted.size, 0, 'a balance never raises a quota alert');
});

test('forge leases: one host reads a source per interval; a dead host lease lapses; a host that cannot read is skipped', () => {
  let t = 1.7e12;
  const r = new Registry({ hosts: ['a', 'b'], ttlMs: 600000, now: () => t });
  const SRC = 'gitea|git.example.org||team/x';
  let seq = 0;
  const send = (host, readings = []) => r.accept(host, parseHostPush({ ...push(), seq: ++seq, forges: { sources: [SRC], readings } })).forgeRead;
  const reading = (extra) => ({ source: SRC, at: t, ...extra });
  const repo = { key: 'git.example.org/team/x', forge: 'gitea', name: 'team/x', at: t, pushedAt: '2026-10-30T10:00:00Z', branches: [], pulls: [] };
  assert.deepEqual([send('a'), send('b')], [[SRC], []], 'two hosts configured: only one is asked');
  t += FORGE_LEASE_MS + 1;
  assert.deepEqual(send('b'), [SRC], 'a never answered (died): its lease lapsed, b takes over');
  assert.deepEqual(send('b', [reading({ repos: [repo] })]), [], 'fresh: nobody reads again');
  assert.deepEqual(send('a'), []);
  assert.deepEqual(send('b', [reading({ repos: [repo] })]), [], 'the same reading again changes nothing (idempotent)');
  assert.deepEqual(r.snapshot().repos.map((x) => [x.key, x.hosts]), [['git.example.org/team/x', ['b']]]);
  t += FORGE_EVERY_MS;
  assert.deepEqual(send('a'), [SRC], 'due again: one host');
  assert.deepEqual(send('a', [reading({ unavailable: 'no token for git.example.org' })]), [], 'a cannot read it: released and skipped');
  assert.deepEqual(send('b'), [SRC], 'b is asked instead');
  assert.deepEqual(send('b', [reading({ error: 'HTTP 401: the token is refused (expired or revoked)' })]), []);
  assert.equal(r.snapshot().repos[0].error, null, 'an error never replaces a good reading');
  const fresh = new Registry({ hosts: ['a'], ttlMs: 600000, now: () => t });
  assert.deepEqual(fresh.accept('a', parseHostPush({ ...push(), forges: { sources: [SRC], readings: [] } })).forgeRead, [SRC]);
  fresh.accept('a', parseHostPush({ ...push(), seq: 2, forges: { sources: [SRC], readings: [reading({ error: 'HTTP 401: refused' })] } }));
  assert.deepEqual(fresh.snapshot().repos.map((x) => [x.key, x.error]), [['git.example.org/team/x', 'HTTP 401: refused']], 'never read well: the error shows');
});

test('code view: the range picks active repos and branches; attention first; sessions meet their branch by repo key', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z');
  const ago = (h) => new Date(NOW - h * 3600000).toISOString();
  const snap = {
    hosts: [{ id: 'h1', sessions: [{ id: 's1', agent: 'claude', repo: 'github.com/o/live', branch: 'feat', status: 'idle' }] }],
    repos: [
      { key: 'github.com/o/live', name: 'o/live', forge: 'github', defaultBranch: 'main', pushedAt: ago(2), hosts: ['h1'],
        branches: [{ name: 'main', at: ago(2), ci: 'failure' }, { name: 'feat', at: ago(5), ci: 'failure' }, { name: 'stale', at: ago(24 * 40), ci: null }],
        pulls: [{ number: 7, head: 'feat', base: 'main', ci: 'failure', conflict: true, updatedAt: ago(5) }] },
      { key: 'github.com/o/quiet', name: 'o/quiet', forge: 'github', defaultBranch: 'main', pushedAt: ago(24 * 10), hosts: ['h1'],
        branches: [{ name: 'main', at: ago(24 * 10), ci: 'success' }], pulls: [] },
    ],
  };
  const day = codeView(snap, 1, NOW);
  assert.deepEqual(day.repos.map((r) => r.key), ['github.com/o/live']);
  assert.equal(day.inactive, 1);
  const [live] = day.repos;
  assert.deepEqual(live.branches.map((b) => b.name), ['main', 'feat'], 'a branch idle past the range is left out');
  assert.equal(live.mainCi, 'failure');
  assert.deepEqual(live.branches[1].sessions.map((s) => s.id), ['s1']);
  assert.equal(live.branches[1].pull.number, 7);
  assert.deepEqual(day.attention.map((a) => a.kind), ['main-failing', 'pr-failing', 'pr-conflict', 'session-failing']);
  assert.deepEqual(codeView(snap, 30, NOW).repos.map((r) => r.key), ['github.com/o/live', 'github.com/o/quiet']);
});

test('forge sources: a port is a valid host; the newer good reading of a repo wins; no host able to read shows why; a source left every config is forgotten', () => {
  let t = 1.7e12;
  const r = new Registry({ hosts: ['a'], ttlMs: 600000, now: () => t });
  const PORT = 'gitea|git.example.org:8443||team/x', OWNER = 'github|github.com|o|', ONE = 'github|github.com||o/r';
  let seq = 0;
  const send = (sources, readings = []) => r.accept('a', parseHostPush({ ...push(), seq: ++seq, forges: { sources, readings } })).forgeRead;
  assert.deepEqual(send([PORT]), [PORT], 'a forge host with a port is a source like any other');
  send([PORT], [{ source: PORT, at: t, unavailable: 'no token for git.example.org:8443' }]);
  assert.deepEqual(r.snapshot().repos.map((x) => x.error), ['no host can read it: a: no token for git.example.org:8443']);
  const repo = (at, ci) => ({ key: 'github.com/o/r', forge: 'github', name: 'o/r', at, pushedAt: '2026-10-30T10:00:00Z', branches: [{ name: 'main', ci }], pulls: [] });
  send([PORT, OWNER, ONE], [{ source: OWNER, at: t, repos: [repo(t, 'failure')] }, { source: ONE, at: t + 1, repos: [repo(t + 1, 'success')] }]);
  send([PORT, OWNER, ONE], [{ source: OWNER, at: t + 2, repos: [repo(t + 2, 'pending')] }]);
  assert.equal(r.snapshot().repos.find((x) => x.key === 'github.com/o/r').branches[0].ci, 'pending', 'the newest reading of a repo two sources cover');
  t += FORGE_FORGET_MS + 1;
  send([OWNER]);
  assert.deepEqual(r.snapshot().repos.map((x) => x.key), ['github.com/o/r'], 'sources no config names any more are gone');
});

test('a forgotten source stays forgotten across a restart', () => {
  let t = 1.7e12;
  const kv = new Map();
  const store = { get: (k) => kv.get(k), put: (k, v) => kv.set(k, structuredClone(v)) };
  const SRC = 'github|github.com||o/r';
  const repo = { key: 'github.com/o/r', forge: 'github', name: 'o/r', at: t, pushedAt: '2026-10-30T10:00:00Z', branches: [], pulls: [] };
  const r = new Registry({ hosts: ['a'], ttlMs: 600000, now: () => t, store });
  r.accept('a', parseHostPush({ ...push(), seq: 1, forges: { sources: [SRC], readings: [{ source: SRC, at: t, repos: [repo] }] } }));
  t += FORGE_FORGET_MS + 1;
  r.accept('a', parseHostPush({ ...push(), seq: 2, forges: { sources: [], readings: [] } }));
  assert.deepEqual(new Registry({ hosts: ['a'], ttlMs: 600000, now: () => t, store }).snapshot().repos, []);
});

test('view: tasks ordered by kind — subagents, monitors, shells, PowerShell — each kind as listed', () => {
  const t = (id, kind) => ({ id, kind, label: id, background: false, startedAt: NOW - 1000 });
  const tasks = [t('s1', 'shell'), t('p1', 'powershell'), t('a1', 'agent'), t('m1', 'monitor'), t('s2', 'shell'), t('a2', 'agent')];
  assert.deepEqual(taskView(tasks, NOW).map((x) => x.id), ['a1', 'a2', 'm1', 's1', 's2', 'p1']);
});

test('view: folded shows the first n task lines and counts the rest; open shows all', () => {
  const xs = ['a', 'b', 'c', 'd'];
  assert.deepEqual(taskLines(xs, false, 2), { shown: ['a', 'b'], more: 2 });
  assert.deepEqual(taskLines(xs, true, 2), { shown: xs, more: 0 });
  assert.deepEqual(taskLines(xs, false, 5), { shown: xs, more: 0 });
});

test('view: a session tasks — only what runs, as listed, each with how long it has run', () => {
  const tasks = [
    { id: 'a', kind: 'agent', label: 'Explore: hooks', background: true, startedAt: NOW - 12 * 60000 },
    { id: 'b', kind: 'shell', label: 'npm test', background: false, startedAt: NOW - 30000 }];
  assert.deepEqual(taskView(tasks, NOW).map((t) => [t.id, t.for]), [['a', '12m'], ['b', '1m']]);
  assert.deepEqual(taskView(undefined, NOW), []);
  const parsed = parseHostPush(push({ sessions: [session({ tasks: [...tasks, { id: 'x', kind: 'daemon', startedAt: NOW }, { id: 'y', kind: 'shell', label: 'ls' }] })] })).sessions[0];
  assert.deepEqual(parsed.tasks, tasks, 'an unknown kind or a task with no start is dropped at the boundary; nothing but these fields passes');
});

test('search: every term in any field, across hosts, sessions, tasks, accounts, repositories, branches, pull requests and config', () => {
  const m = mockDashboard(NOW);
  m.hosts[0].sessions[0].tasks = [{ id: 't1', kind: 'shell', label: 'npm run migrate', background: false, startedAt: NOW - 60000 }];
  const kinds = (q) => searchAll(m, q, { now: NOW }).map((r) => `${r.kind}:${r.title}`);
  assert.deepEqual(searchAll(m, '  ', { now: NOW }), [], 'an empty query finds nothing');
  assert.ok(kinds('OAUTH').includes('session:OAuth token refresh'), 'case-insensitive, by session name');
  assert.ok(kinds('OAUTH').includes('pull:#42 OAuth token refresh'), 'and the pull request of the same name');
  assert.deepEqual(kinds('migrate'), ['task:npm run migrate'], 'a running command');
  assert.ok(kinds('feature auth').every((k) => /feature\/auth|OAuth/.test(k)), 'every term must match');
  assert.ok(kinds('feature/auth').includes('branch:example/backend-api feature/auth'));
  assert.ok(kinds('alice@example').some((k) => k.startsWith('account:')), 'an account by email');
  assert.ok(kinds('host-c').includes('host:host-c'));
  assert.ok(kinds('idleClose').some((k) => k.startsWith('config:')), 'a shared setting by key');
  const [pull] = searchAll(m, '#42', { now: NOW });
  assert.equal(pull.url, 'https://github.com/example/backend-api/pull/42', 'a forge item opens the forge');
  const [task] = searchAll(m, 'migrate', { now: NOW });
  assert.equal(task.session.id, '0b6c4e1a-1111', 'a task opens its session');
  assert.equal(searchAll({ ...m, hosts: [] }, 'x', { now: NOW, max: 1 }).length <= 1, true, 'bounded');
});

test('offline: a host in offlineAlertExclude is never alerted; an unknown id there is dropped', () => {
  let t = NOW;
  const sent = [];
  const r = new Registry({ hosts: ['host-a', 'host-b'], now: () => t, offlineAlertMs: 300000, offlineAlertExclude: ['host-b'], notify: (a) => { sent.push(a); } });
  t += 400000;
  assert.equal(r.sweep(), null);
  assert.deepEqual(sent.map((a) => a.host), ['host-a']);
  assert.deepEqual(parseDashboardConfig({ botId: 1, hosts: { 'host-a': 'a'.repeat(64) }, offlineAlertExclude: ['host-a', 'nope'] }).offlineAlertExclude, ['host-a']);
});

test('waiting: what a session waits for passes the boundary only while it waits, bounded; it is searchable', () => {
  const long = 'x'.repeat(WAITING_MAX + 50);
  const [a, b] = parseHostPush(push({ sessions: [session({ status: 'needs_approval', waiting: long }), session({ id: 's2', status: 'idle', waiting: 'stale' })] })).sessions;
  assert.equal(a.waiting.length, WAITING_MAX);
  assert.equal(b.waiting, undefined, 'an idle session waits for nothing');
  const m = mockDashboard(NOW);
  m.hosts[0].sessions[1].waiting = '$ rm -rf build';
  const kinds = searchAll(m, 'rm -rf', { now: NOW }).map((r) => `${r.kind}:${r.title}`);
  assert.deepEqual(kinds, ['session:Landing page redesign']);
});

test('account: a session names the account it spends, as the Quota tab names it, else its seat or platform; searchable', () => {
  const m = mockDashboard(NOW);
  const byKey = (k) => m.accounts.find((q) => q.key === k);
  const [claude, codex] = m.hosts[0].sessions;
  assert.equal(sessionAccountLabel(claude, byKey(claude.account)), 'team-a', 'a Claude seat by its label');
  assert.equal(sessionAccountLabel(codex, byKey(codex.account)), 'bob', 'an unlabelled account by its email name');
  assert.equal(sessionAccountLabel({ agent: 'claude', seat: 'team-b' }, undefined), 'team-b', 'no reading: the seat');
  assert.equal(sessionAccountLabel({ agent: 'codex', provider: 'deepseek' }, undefined), 'DeepSeek', 'an API platform');
  assert.equal(sessionAccountLabel({ agent: 'claude' }, undefined), null);
  assert.ok(searchAll(m, 'bob', { now: NOW }).some((r) => r.kind === 'session' && r.session.id === codex.id), 'a session by its account');
});

test('unread sessions: one record per session built on unreadHere; first sight and tool activity are not unread', async () => {
  const { unreadState, readMark, unreadCount, syncSeen } = await import('./public/view.mjs');
  const s = { id: 'a', status: 'working', posted: 2, unread: 2 };
  assert.deepEqual(unreadState(s, undefined), { count: 0, unread: false }, 'never seen here: not unread');
  assert.deepEqual(syncSeen([s], {}), { a: { p: 2, w: null } }, 'first sight is read as it is: no flood');
  const rec = readMark(s);
  assert.equal(unreadState({ ...s, lastActivityAt: 'x', tasks: [{}] }, rec).unread, false, 'tool activity is not unread');
  assert.deepEqual(unreadState({ ...s, posted: 3, unread: 3 }, rec), { count: 1, unread: true }, 'a new answer counts');
  assert.deepEqual(unreadState({ ...s, posted: 3, unread: 0 }, rec), { count: 0, unread: false }, 'the human replied elsewhere: read');
  assert.deepEqual(unreadState({ ...s, posted: 1, unread: 1 }, rec), { count: 1, unread: true }, 'posted reset below seen: the host count stands');
  assert.equal(unreadState({ ...s, status: 'needs_approval', waiting: 'Bash' }, rec).unread, true, 'a new wait');
  assert.equal(unreadState({ ...s, status: 'needs_approval', waiting: 'Bash' }, rec).count, 0, 'a wait is a dot, not a number');
  const waiting = { ...s, status: 'needs_input', waiting: 'Q?' };
  assert.equal(unreadState(waiting, readMark(waiting)).unread, false, 'a wait already seen');
  assert.equal(unreadState({ ...waiting, waiting: 'Q2?' }, readMark(waiting)).unread, true, 'another question');
  const seen = syncSeen([waiting, { id: 'b', posted: 5 }], { a: readMark(waiting), gone: { p: 1, w: null }, b: 'junk' });
  assert.deepEqual(Object.keys(seen).sort(), ['a', 'b'], 'gone pruned');
  assert.deepEqual(seen.b, { p: 5, w: null }, 'a malformed record is replaced');
  assert.equal(unreadCount([waiting, { id: 'b', posted: 5 }], seen), 0);
  const after = syncSeen([{ ...s }], seen);
  assert.equal(after.a.w, null, 'the wait ended');
  assert.equal(unreadState(waiting, after.a).unread, true, 'the same question asked again is new');
  assert.equal(unreadCount([{ ...s, posted: 9, unread: 7 }, { id: 'b', posted: 6, unread: 1 }], { ...after, b: seen.b }), 2);
});

test('mark unread and mark read: a manual mark survives everything but reading', async () => {
  const { unreadState, readMark, unreadMark, syncSeen, unreadCount } = await import('./public/view.mjs');
  const s = { id: 'a', status: 'idle', posted: 4, unread: 0 };
  const m = unreadMark(s, readMark(s));
  assert.deepEqual(unreadState(s, m), { count: 0, unread: true }, 'marked unread with nothing new: a dot');
  assert.deepEqual(unreadState({ ...s, posted: 6, unread: 2 }, m), { count: 2, unread: true }, 'a new post: the number grows');
  assert.equal(unreadState({ ...s, posted: 6, unread: 0 }, m).unread, true, 'a reply elsewhere leaves the manual mark');
  assert.equal(syncSeen([s], { a: m }).a.m, true, 'sync keeps the mark');
  assert.equal(syncSeen([{ ...s, posted: 0 }], { a: m }).a.m, true, 'a resumed session with its counter reset keeps it');
  assert.deepEqual(unreadMark(s, undefined), { p: 4, w: null, m: true }, 'marking a never-seen session');
  assert.equal(unreadState(s, readMark(s)).unread, false, 'mark read clears it');
  const rows = [s, { id: 'b', status: 'needs_input', waiting: 'Q', posted: 1, unread: 1 }];
  const all = Object.fromEntries(rows.map((x) => [x.id, readMark(x)]));
  assert.equal(unreadCount(rows, { a: m, b: { p: 0, w: null } }), 2);
  assert.equal(unreadCount(rows, all), 0, 'mark all read clears counts, waits and manual marks');
});
