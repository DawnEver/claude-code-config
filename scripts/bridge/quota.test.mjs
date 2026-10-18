import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccountReader, accountModels, recordsQuota, planName, teeClaudeUsage, windowView, project, claudeWindows, codexWindows, quotaOf, readClaudeDirs } from './quota.mjs';
import { readSeries } from './quota-series.mjs';

// One observation as a series: what a host knows the moment it first sees its quota.
const claudeQuota = (snap) => (snap?.at > 0 ? quotaOf([{ from: snap.at, at: snap.at, windows: claudeWindows(snap) }]) : null);
const codexQuota = (limits, at) => (limits ? quotaOf([{ from: at, at, windows: codexWindows(limits) }]) : null);

const H = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0);
const SEAT = { email: 'a@example.com', org: 'Team A', machines: ['m1'] };
const SEATS = [SEAT];
const ME = { email: 'a@example.com', org: 'Uni Team A', orgUuid: 'u1' };
const short5h = (at = NOW) => claudeQuota({ at, five_hour: { used_percentage: 60, resets_at: (NOW + 3 * H) / 1000 } });
const models = ({ account = ME, quota = null, dirs, seats = SEATS, machine = 'm1', ...o } = {}) =>
  accountModels({ machine, seats, now: NOW, claude: dirs ?? [{ alias: null, account, quota }], ...o });
const problems = (o) => models(o).flatMap((a) => a.problems);

test('windowView: the average pace since opening, null too early; junk or past reset is null', () => {
  // 5h window, 4h elapsed, 80% used -> 20%/h.
  assert.equal(Math.round(windowView({ used: 80, resetsAt: NOW + H, windowMs: 5 * H, at: NOW }).perHour), 20);
  assert.equal(windowView({ used: 30, resetsAt: NOW + 4.8 * H, windowMs: 5 * H, at: NOW }).perHour, null);
  assert.equal(windowView({ used: 90, resetsAt: NOW - 1, windowMs: 5 * H, at: NOW }), null);
  assert.equal(windowView({ used: 'x', resetsAt: NOW + H, windowMs: 5 * H, at: NOW }), null);
});

test('project: the current speed, else the average, to the reset; one forecast', () => {
  const v = windowView({ used: 60, resetsAt: NOW + 3 * H, windowMs: 5 * H, at: NOW });   // 30%/h average
  // Average 30%/h: out in 80 min, before the reset in 3h.
  assert.deepEqual(project(v, { now: NOW, fresh: true }), { rate: 30, atReset: 150, eta: NOW + (40 / 30) * H, short: true });
  // Slowed to 10%/h in the last hour: lasts, at 90% by the reset.
  assert.deepEqual(project(v, { recent: 10, now: NOW, fresh: true }), { rate: 10, atReset: 90, eta: NOW + 4 * H, short: false });
  assert.equal(project(v, { recent: 0, now: NOW, fresh: true }).eta, null, 'idle: never runs out');
  assert.equal(project(v, { now: NOW, fresh: false }), null, 'a stale reading forecasts nothing');
  assert.equal(project({ ...v, perHour: null }, { recent: 50, now: NOW, fresh: true }), null, 'too early in the window');
  assert.equal(project({ ...v, used: 100 }, { now: NOW, fresh: true }), null, 'exhausted says so itself');
});

test('quota windows are labelled by their real length; distinct short windows do not collide', () => {
  const c = claudeQuota({ at: NOW, five_hour: { used_percentage: 50, resets_at: (NOW + 2 * H) / 1000 },
    seven_day: { used_percentage: 10, resets_at: (NOW + 100 * H) / 1000 } });
  assert.deepEqual(Object.keys(c.windows), ['5h', '7d']);
  const x = codexQuota({ primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: (NOW + H) / 1000 },
    secondary: { usedPercent: 5, windowDurationMins: 60, resetsAt: (NOW + 0.5 * H) / 1000 } }, NOW);
  assert.deepEqual(Object.keys(x.windows), ['5h', '1h']);
  assert.equal(claudeQuota(null), null);
  assert.equal(codexQuota(null, NOW), null);
});

test('readClaudeDirs reads the base dir and each local seat dir: account and quota from its own files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-home-'));
  const acct = (email, org) => JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: org, organizationUuid: org } });
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude.json'), acct('a@example.com', 'Team A'));
    fs.mkdirSync(path.join(home, '.claude-team-b', 'bridge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude-team-b', '.claude.json'), acct('a@example.com', 'Team B'));
    teeClaudeUsage({ rate_limits: { five_hour: { used_percentage: 10, resets_at: (NOW + H) / 1000 } } }, { file: path.join(home, '.claude-team-b', 'bridge', 'claude-usage.jsonl'), now: NOW });
    const seats = [{ alias: 'team-b', machines: ['m1'] }, { alias: 'team-a', machines: ['m1'] }, { alias: 'other', machines: ['m2'] }];
    const dirs = readClaudeDirs(seats, 'm1', home);
    assert.deepEqual(dirs.map((d) => [d.alias, d.account?.org, Boolean(d.quota)]), [[null, 'Team A', false], ['team-b', 'Team B', true]], 'a seat without its dir is skipped');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('teeClaudeUsage records the statusLine quota as normalized windows in the config dir series', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
  try {
    const file = path.join(dir, 'b', 'claude-usage.jsonl');
    const line = { rate_limits: { five_hour: { used_percentage: 5, resets_at: (NOW + H) / 1000 } } };
    assert.equal(teeClaudeUsage({ model: {} }, { file, now: NOW }), false, 'no rate_limits, nothing written');
    assert.equal(teeClaudeUsage(line, { file, now: NOW }), true);
    assert.deepEqual(readSeries(file), [{ from: NOW, at: NOW, windows: { '5h': { used: 5, resetsAt: NOW + H, windowMs: 5 * H } } }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('planName shows the sold name for wire plan ids', () => {
  assert.equal(planName('team_labs_premium'), 'Team Premium');
  assert.equal(planName('edu_plus'), 'Edu Plus');
});

test('accountModels: numbers as data — use, reset, trend cells and the forecast; no rendering', () => {
  const [a] = models({ quota: short5h() });
  assert.deepEqual([a.agent, a.email, a.detail, a.key], ['claude', 'a@example.com', 'Uni Team A', 'claude:a@example.com|u1'],
    'one key per account and org, so hosts on one seat merge');
  const [w] = a.windows;
  assert.deepEqual([w.k, w.used, w.resetsAt, w.windowMs], ['5h', 60, NOW + 3 * H, 5 * H]);
  assert.deepEqual([w.forecast.short, Math.round(w.forecast.atReset)], [true, 150]);
  // 60% in the first 2h of 5h is 1.5x an even spend in each of the 4 past 30-min cells; the rest is ahead.
  assert.deepEqual(w.cells.map((c) => (c === null ? null : Math.round(c * 10) / 10)), [1.5, 1.5, 1.5, 1.5, null, null, null, null, null, null]);
  assert.equal(models({ quota: short5h(NOW - 30 * 60000) })[0].windows[0].forecast, null, 'a stale reading forecasts nothing');
  assert.ok(models({ quota: short5h(NOW - 30 * 60000) })[0].windows[0].cells.includes(-1), 'unobserved cells are -1');
  const renewed = models({ quota: short5h(), now: NOW + 4 * H })[0].windows[0];
  assert.deepEqual([renewed.used, renewed.resetsAt, renewed.cells, renewed.forecast], [0, null, [], null], 'a passed reset is a new window not yet started');
  assert.deepEqual(models(), [], 'no quota and no seat problem: nothing to show');
});

test('accountModels: Codex account, plan and reset credits still to spend', () => {
  const [cx] = accountModels({ machine: 'm1', seats: SEATS, now: NOW, codexAccount: { email: 'C@example.com', plan: 'pro' },
    codex: codexQuota({ primary: { windowDurationMins: 300, usedPercent: 10, resetsAt: (NOW + H) / 1000 } }, NOW),
    codexResetCredits: { availableCount: 2, credits: [{ expiresAt: (NOW + 5 * H) / 1000 }, { expiresAt: (NOW - H) / 1000 }] } });
  assert.deepEqual([cx.key, cx.detail, cx.resetCredits], ['codex:c@example.com', 'Pro', { count: 2, expiries: [NOW + 5 * H] }]);
});

test('seat checks name the expected seat in full', () => {
  assert.deepEqual(problems({ quota: short5h() }), []);
  assert.deepEqual(problems({ account: { ...ME, email: 'b@example.com' } }), ['wrong account, expected a@example.com · Team A']);
  assert.deepEqual(problems({ account: { ...ME, org: 'Team B' } }), ['wrong team, expected a@example.com · Team A']);
  assert.deepEqual(problems({ seats: [{ ...SEAT, orgUuid: 'u2' }] }), ['wrong team, expected a@example.com · Team A']);
  assert.deepEqual(problems({ account: null }), ['no subscription login, expected a@example.com · Team A']);
  const seated = [{ ...SEAT, alias: 'a' }];
  assert.deepEqual(problems({ seats: seated, dirs: [{ alias: null, account: ME, quota: short5h() }, { alias: 'a', account: null, quota: null }] }), [],
    'an empty seat dir is fine when the base dir holds its seat');
  assert.deepEqual(problems({ seats: seated, dirs: [{ alias: 'a', account: null, quota: short5h() }] }), ['no subscription login, expected a@example.com · Team A']);
  assert.deepEqual(problems({ machine: 'm9' }), ['m9 is not in seats']);
  assert.deepEqual(models({ machine: 'm9', seats: null }), [], 'no seats configured: nothing to check');
  assert.deepEqual(problems({ dirs: [{ alias: null, account: ME, quota: null }, { alias: 'team-b', account: ME, quota: null }] }),
    ['seat team-b is not registered for m1']);
});

test('one account per seat, each with its own login and quota; the base dir joins the seat it holds', () => {
  const seats = [{ alias: 'team-a', email: 'a@example.com', org: 'Team A', machines: ['m1'] },
    { alias: 'team-b', email: 'a@example.com', org: 'Team B', machines: ['m1'] }];
  const A = { ...ME, org: 'Team A' }, B = { ...ME, org: 'Team B', orgUuid: 'u2' };
  const out = models({ seats, dirs: [{ alias: null, account: null, quota: null },
    { alias: 'team-a', account: A, quota: short5h() }, { alias: 'team-b', account: B, quota: short5h() }] });
  assert.deepEqual(out.map((a) => [a.label, a.detail]), [['team-a', 'Team A'], ['team-b', 'Team B']],
    'the unassigned, logged-out base dir says nothing on a multi-seat machine');
  const merged = models({ seats: [seats[0]], dirs: [{ alias: null, account: A, quota: short5h() }, { alias: 'team-a', account: A, quota: short5h(NOW - 30 * 60000) }] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].at, NOW, 'the freshest quota wins');
});

test('AccountReader: extra resets fetched in the background at most once per interval', async () => {
  let fetches = 0, t = NOW;
  const r = new AccountReader({ machine: 'm1', now: () => t, extraEveryMs: 60000,
    extraResets: async () => { fetches++; return { Claude: { scheduled: { at: NOW + H, url: 'https://x.test/r' } } }; },
    sources: { seats: () => SEATS, claude: () => [{ alias: null, account: ME, quota: short5h() }] } });
  assert.equal(r.read()[0].extraReset, null, 'the first read does not wait for the network');
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(r.read()[0].extraReset, { at: NOW + H, url: 'https://x.test/r' });
  r.read();
  assert.equal(fetches, 1);
  t += 61000;
  r.read();
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(fetches, 2);
});

test('recordsQuota: a host without a configured dashboard records nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cfg-'));
  try {
    const sharedPath = path.join(dir, 's.json'), localPath = path.join(dir, 'l.json');
    const write = (shared, local) => { fs.writeFileSync(sharedPath, JSON.stringify(shared)); fs.writeFileSync(localPath, JSON.stringify(local)); };
    write({}, {});
    assert.equal(recordsQuota({ sharedPath, localPath }), false, 'unconfigured: off');
    write({ bridge: { dashboard: { url: 'https://dashboard.example.com' } } }, {});
    assert.equal(recordsQuota({ sharedPath, localPath }), false, 'shared url alone: this host is not on it');
    write({ bridge: { dashboard: { url: 'https://dashboard.example.com' } } }, { bridge: { dashboard: { hostToken: 't' } } });
    assert.equal(recordsQuota({ sharedPath, localPath }), true);
    assert.equal(recordsQuota({ sharedPath: path.join(dir, 'missing.json'), localPath }), false, 'no settings at all');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
