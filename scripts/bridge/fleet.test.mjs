import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetReport, planName, reportSlot, when, countdown, teeClaudeUsage, windowView, claudeQuota, codexQuota, readClaudeDirs, renderReport } from './fleet.mjs';

const H = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0);
const SEAT = { email: 'a@example.com', org: 'Team A', machines: ['m1'] };
const REG = { seats: [SEAT] };
const ME = { email: 'a@example.com', org: 'Uni Team A', orgUuid: 'u1' };
const short5h = (at = NOW) => claudeQuota({ at, five_hour: { used_percentage: 60, resets_at: (NOW + 3 * H) / 1000 } });

test('windowView projects exhaustion from the average pace since the window opened', () => {
  // 5h window, 4h elapsed, 80% used -> 20%/h -> out exactly at reset: not short.
  const even = windowView({ used: 80, resetsAt: NOW + H, windowMs: 5 * H, at: NOW });
  assert.deepEqual([Math.round(even.perHour), even.short], [20, false]);
  // 2h elapsed, 60% used -> 30%/h -> out in 80 min, reset in 3h: short.
  const fast = windowView({ used: 60, resetsAt: NOW + 3 * H, windowMs: 5 * H, at: NOW });
  assert.deepEqual([fast.short, fast.eta], [true, NOW + (40 / 60) * 2 * H]);
});

test('windowView: too early to project, exhausted even when early, junk or past reset is null', () => {
  const early = windowView({ used: 30, resetsAt: NOW + 4.8 * H, windowMs: 5 * H, at: NOW });
  assert.deepEqual([early.perHour, early.short], [null, false]);
  assert.equal(windowView({ used: 100, resetsAt: NOW + 4.9 * H, windowMs: 5 * H, at: NOW }).short, true);
  assert.equal(windowView({ used: 90, resetsAt: NOW - 1, windowMs: 5 * H, at: NOW }), null);
  assert.equal(windowView({ used: 'x', resetsAt: NOW + H, windowMs: 5 * H, at: NOW }), null);
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-home-'));
  const acct = (email, org) => JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: org, organizationUuid: org } });
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude.json'), acct('a@example.com', 'Team A'));
    fs.mkdirSync(path.join(home, '.claude-team-b', 'bridge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude-team-b', '.claude.json'), acct('a@example.com', 'Team B'));
    fs.writeFileSync(path.join(home, '.claude-team-b', 'bridge', 'claude-usage.json'), JSON.stringify({ at: NOW, five_hour: { used_percentage: 10, resets_at: (NOW + H) / 1000 } }));
    const seats = [{ alias: 'team-b', machines: ['m1'] }, { alias: 'team-a', machines: ['m1'] }, { alias: 'other', machines: ['m2'] }];
    const dirs = readClaudeDirs(seats, 'm1', home);
    assert.deepEqual(dirs.map((d) => [d.alias, d.account?.org, Boolean(d.quota)]), [[null, 'Team A', false], ['team-b', 'Team B', true]], 'a seat without its dir is skipped');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('teeClaudeUsage keeps the latest rate_limits, skipping unchanged renders for a minute', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  try {
    const file = path.join(dir, 'b', 'claude-usage.json');
    const line = { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } };
    assert.equal(teeClaudeUsage({ model: {} }, { file, now: 1 }), false, 'no rate_limits, nothing written');
    assert.equal(teeClaudeUsage(line, { file, now: 1 }), true);
    assert.equal(teeClaudeUsage(line, { file, now: 30000 }), false);
    assert.equal(teeClaudeUsage(line, { file, now: 61001 }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: 61001, five_hour: { used_percentage: 5, resets_at: 1 }, seven_day: null });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['claude-usage.json'], 'no temp file left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeTelegram() {
  const t = { sent: [], deleted: [], fail: null };
  t.sendMessage = async (chat, text, opts) => { if (t.fail?.(text)) throw new Error('down'); t.sent.push({ chat, text, ...opts }); return [{ message_id: t.sent.length }]; };
  t.deleteMessage = async (chat, id) => { t.deleted.push(id); };
  return t;
}

const ROUND = 60 * 60000;
function fleet({ telegram = fakeTelegram(), stateFile = null, topicId = 9, clock = { t: NOW }, used = { v: 60 }, machine = 'm1' } = {}) {
  const card = new FleetReport({ telegram, chatId: -1, topicId, machine, now: () => clock.t, stateFile, extraResets: async () => null,
    sessions: () => [{ agent: 'codex', project: 'p', branch: 'main', status: 'Working' }],
    codexQuota: () => ({ limits: { primary: { usedPercent: used.v, windowDurationMins: 300, resetsAt: (NOW + 3 * H) / 1000 } }, at: clock.t }),
    read: { registry: () => ({ ...REG, order: ['m0', 'm1'] }), claude: () => [{ alias: null, account: ME, quota: null }] } });
  return { card, telegram, clock, used };
}

test('when: today as a time, any other day as a date', () => {
  const now = new Date(2026, 9, 3, 12, 0).getTime();
  assert.equal(when(new Date(2026, 9, 3, 21, 5).getTime(), now), '21:05');
  assert.equal(when(new Date(2026, 9, 8, 23, 0).getTime(), now), '08/Oct 23:00');
});

test('reportSlot follows bridge.fleet order, a minute apart; unlisted machines report last', () => {
  const reg = { order: ['h1', 'h2', 'h3'] };
  assert.deepEqual(['h1', 'h2', 'h3', 'X'].map((m) => reportSlot(reg, m) / 60000), [0, 1, 2, 3]);
  assert.equal(reportSlot(null, 'h2'), 0);
});

test('FleetReport reports once per round at its slot, replacing its previous report', async () => {
  const { card, telegram: tg, clock } = fleet({ clock: { t: NOW + 5 * 60000 } });
  const reports = () => tg.sent.filter((m) => m.rich);
  await card.tick();
  assert.equal(reports().length, 1);
  assert.deepEqual([reports()[0].threadId, reports()[0].alert], [9, undefined]);
  clock.t += 30 * 60000; await card.tick();
  assert.equal(reports().length, 1, 'no report within the round');
  const next = Math.ceil((clock.t - 60000) / ROUND) * ROUND + 60000;   // m1's slot: one minute in
  clock.t = next - 1; await card.tick();
  assert.equal(reports().length, 1, 'not before its slot');
  clock.t = next; await card.tick();
  assert.equal(reports().length, 2);
  assert.deepEqual(tg.deleted, [1], 'the previous report is removed');
});


test('FleetReport: one message per round, never between rounds; overlapping ticks share one run', async () => {
  const tg = fakeTelegram();
  const { card, clock, used } = fleet({ telegram: tg, clock: { t: NOW + 5 * 60000 } });
  await Promise.all([card.tick(), card.tick()]);
  assert.equal(tg.sent.length, 1, 'just the report: a run-out warning is a line in it');
  used.v = 99; clock.t += 60000; await card.tick();
  assert.equal(tg.sent.length, 1, 'quota changes wait for the next round');
});

test('FleetReport state is per chat/Topic, saved only on change, and holds no email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  try {
    const stateFile = path.join(dir, 'fleet-report.json');
    await fleet({ stateFile }).card.tick();
    const saved = fs.statSync(stateFile).mtimeMs;
    const again = fleet({ stateFile });
    assert.equal(again.card.state.messageId, 1);
    await again.card.tick();
    assert.equal(fs.statSync(stateFile).mtimeMs, saved, 'nothing changed, nothing written');
    assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /example\.com/);
    assert.equal(fleet({ stateFile, topicId: 10 }).card.state.messageId, null, 'another Topic starts afresh');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('planName shows the sold name for wire plan ids', () => {
  assert.deepEqual([planName('self_serve_business_prolite'), planName('plus'), planName('edu_plus')], ['Business Premium', 'Plus', 'Edu Plus']);
});

test('FleetReport fetches extra resets once per report', async () => {
  let calls = 0;
  const tg = fakeTelegram();
  const clock = { t: NOW + 5 * 60000 };
  const card = new FleetReport({ telegram: tg, chatId: -1, machine: 'm1', now: () => clock.t, extraResets: async () => { calls++; return null; },
    read: { registry: () => REG, claude: () => [{ alias: null, account: ME, quota: null }] } });
  await card.tick(); clock.t += 60000; await card.tick();
  assert.equal(calls, 1);
});


const RUN = (agent, status = 'Working') => ({ agent, project: 'proj-x', branch: 'main', status });
const render = ({ account = ME, claude = null, dirs, ...o }) => renderReport({ machine: 'm1', registry: REG, now: NOW, claude: dirs ?? [{ alias: null, account, quota: claude }], ...o });

test('renderReport: no machine title; the heading is the verdict, then the warning, then the account', () => {
  const text = render({ claude: short5h(), sessions: [RUN('claude')] });
  assert.match(text, /^## Claude · 40% left\n\n\*\*\(\\!\) 5h runs out \d\d:\d\d \\\(1h 20m\\\) · resets \d\d:\d\d \\\(3h 0m\\\)\*\*\n\n`a@example\.com` · _Uni Team A_\n\n/);
  assert.doesNotMatch(text, /m1/, 'the posting bot already names the machine');
  assert.match(text, /\| 5h \| `████┃██░░░░` 60% \/ 40% \| \d\d:\d\d \\\(3h 0m\\\) \|/);
  assert.match(text, /\n- \*\*proj\\-x\*\* · main$/);
});

test('a stale snapshot is a lower bound on use: no age line, no projection', () => {
  const text = render({ claude: short5h(NOW - 30 * 60000), sessions: [RUN('claude')] });
  assert.match(text, /^## Claude · ≤40% left\n/);
  assert.match(text, /\| 5h \| `[^`]+` ≥60% \/ \d+% \|/);
  assert.doesNotMatch(text, /runs out|old/);
});

test('an exhausted window says so until it resets, however old the snapshot', () => {
  const q = claudeQuota({ at: NOW - 32 * H, seven_day: { used_percentage: 100, resets_at: (NOW + 42 * H) / 1000 } });
  const text = render({ claude: q, sessions: [RUN('claude')] });
  assert.match(text, /^## Claude · 0% left\n\n\*\*\(\\!\) 7d exhausted · resets \d\d\/Oct \d\d:\d\d \\\(1d 18h\\\)\*\*\n/);
  assert.match(text, /\| 7d \| `[^`]+` 100% \//);
  assert.doesNotMatch(text, /runs out|old/);
});

test('pace is read at render time: a 30h-old snapshot still marks the current even spend', () => {
  // Reset 44h away now (124h of 168h elapsed = 74%); the snapshot was taken 30h earlier.
  const q = claudeQuota({ at: NOW - 30 * H, seven_day: { used_percentage: 100, resets_at: (NOW + 44 * H) / 1000 } });
  assert.match(render({ claude: q, sessions: [RUN('claude')] }), /\| 7d \| `███████┃███` 100% \/ 74% \|/);
});

test('quota bar: the pace marker is inserted, never hiding a cell of fill', () => {
  // Exhausted at 55% pace: a full bar, not one that reads as half used.
  const full = claudeQuota({ at: NOW, seven_day: { used_percentage: 100, resets_at: (NOW + 75.6 * H) / 1000 } });
  assert.match(render({ claude: full, sessions: [RUN('claude')] }), /\| 7d \| `██████┃████` 100% \/ 55% \|/);
  // 26% used vs 24% pace: the fill visibly runs past the marker (over pace).
  const over = claudeQuota({ at: NOW, seven_day: { used_percentage: 26, resets_at: (NOW + 128 * H) / 1000 } });
  assert.match(render({ claude: over, sessions: [RUN('claude')] }), /\| 7d \| `██┃█░░░░░░░` 26% \/ 24% \|/);
});

test('renderReport shows a host only when it runs something, has a reset to act on, or a seat problem', () => {
  assert.match(render({ sessions: [RUN('claude', 'Idle'), RUN('codex', 'Unknown')] }), /^## Claude[\s\S]*_Idle_[\s\S]*## Codex[\s\S]*_Unknown_/, 'any registered session counts');
  assert.match(render({ sessions: [RUN('codex', 'Needs approval')] }), /^## Codex[\s\S]*proj\\-x\*\* · main · _Needs approval_/);
  assert.match(render({ sessions: [RUN('claude', 'Needs input')] }), /^## Claude[\s\S]*proj\\-x\*\* · main · _Needs input_/);
  assert.match(render({ extra: { Claude: { banked: [{ id: 'o', name: 'Opus 5.5', expires: NOW + 18 * 24 * H }], scheduled: null } } }),
    /^## Claude[\s\S]*`banked reset \(Opus 5\.5\) · use by \d\d\/Oct \d\d:\d\d \(18d 0h\)`$/);
  assert.equal(render({ registry: { seats: [{ ...SEAT, claimed: ['o'] }] }, extra: { Claude: { banked: [{ id: 'o', expires: NOW + H }], scheduled: null } } }), null, 'a claimed reset is not offered');
  assert.match(render({ codexResetCredits: { availableCount: 2, credits: [{ expiresAt: (NOW + 20 * H) / 1000 }, { expiresAt: null }] } }),
    /^## Codex[\s\S]*`reset credits: 2`\n\n- expires \d\d\/Oct \d\d:\d\d \\\(20h 0m\\\)\n- no expiry$/);
  assert.equal(render({ codexResetCredits: { availableCount: 0, credits: [] } }), null);
  assert.match(render({ extra: { Codex: { banked: [], scheduled: { at: NOW + 2 * H, url: 'https://x/s' } } } }), /^## Codex[\s\S]*\*\*\[extra reset announced\]\(https:\/\/x\/s\)\*\* · \d\d:\d\d \\\(2h 0m\\\)$/);
});

test('renderReport seat problems show the Claude block and name the expected seat in full', () => {
  const warn = (o) => (render(o) ?? '').match(/\*\*\(\\!\) (wrong|no|m\d)[^*]*\*\*/g) ?? [];
  assert.deepEqual(warn({}), []);
  assert.deepEqual(warn({ account: { ...ME, email: 'b@example.com' } }), ['**(\\!) wrong account, expected a@example\\.com · Team A**']);
  assert.deepEqual(warn({ account: { ...ME, org: 'Team B' } }), ['**(\\!) wrong team, expected a@example\\.com · Team A**']);
  assert.deepEqual(warn({ registry: { seats: [{ ...SEAT, orgUuid: 'u2' }] } }), ['**(\\!) wrong team, expected a@example\\.com · Team A**']);
  assert.deepEqual(warn({ account: null }), ['**(\\!) no subscription login, expected a@example\\.com · Team A**']);
  assert.match(render({ account: null }), /\n\n_not logged in_\n\n/);
  assert.deepEqual(warn({ machine: 'm9' }), ['**(\\!) m9 is not in seats**']);
  assert.equal(render({ machine: 'm9', registry: null }), null, 'no seats configured: nothing to check');
});

test('renderReport: a passed reset reads as renewed; values are Markdown-escaped', () => {
  assert.match(render({ claude: short5h(), sessions: [RUN('claude')], now: NOW + 4 * H }), /\| 5h \| renewed \| — \|/);
  const text = render({ account: { email: 'a@example.com', org: 'Team_[A]*' }, sessions: [{ ...RUN('claude'), project: 'p|q#1' }] });
  assert.match(text, /_Team\\_\\\[A\\\]\\\*_/);
  assert.match(text, /\*\*p\\\|q\\#1\*\*/);
});

test('time formats: both (default), date, countdown', () => {
  assert.deepEqual([countdown(NOW + 4 * 1440 * 60000 + 7 * H, NOW), countdown(NOW + 3 * H + 15 * 60000, NOW), countdown(NOW + 12 * 60000, NOW), countdown(NOW - 19 * H, NOW)], ['4d 7h', '3h 15m', '12m', '19h 0m ago']);
  const card = (timeFormat) => render({ registry: { ...REG, timeFormat }, claude: short5h(), sessions: [RUN('claude')] });
  assert.match(card(undefined), /resets \d\d:\d\d \\\(3h 0m\\\)\*\*/);
  assert.match(card('date'), /resets \d\d:\d\d\*\*/);
  assert.match(card('countdown'), /runs out 1h 20m · resets 3h 0m\*\*/);
});

test('FleetReport posts nothing when there is nothing to say, and still retires the old report', async () => {
  const tg = fakeTelegram();
  const card = new FleetReport({ telegram: tg, chatId: -1, machine: 'm1', now: () => NOW + 5 * 60000, extraResets: async () => null,
    read: { registry: () => REG, claude: () => [{ alias: null, account: ME, quota: null }] } });
  card.state.messageId = 7;
  await card.tick();
  assert.deepEqual([tg.sent.length, tg.deleted, card.state.messageId], [0, [7], null]);
});

test('renderReport bridge.fleet.always: an idle host with quota data still reports — Claude by default, Codex on request', () => {
  assert.match(render({ claude: short5h() }), /^## Claude · 40% left[\s\S]*\| 5h \|/, 'Claude on by default');
  assert.equal(render({}), null, 'no quota data: nothing to say');
  assert.equal(render({ codex: short5h() }), null, 'Codex off by default');
  assert.match(render({ registry: { ...REG, always: { codex: true } }, codex: short5h() }), /^## Codex/);
  assert.equal(render({ registry: { ...REG, always: { claude: false } }, claude: short5h() }), null);
});

test('renderReport: one Claude block per seat, each with its own account, quota and sessions', () => {
  const seats = [{ alias: 'team-a', email: 'a@example.com', org: 'Team A', machines: ['m1'] },
    { alias: 'team-b', email: 'a@example.com', org: 'Team B', machines: ['m1'] }];
  const A = { ...ME, org: 'Team A' }, B = { ...ME, org: 'Team B', orgUuid: 'u2' };
  const text = render({ registry: { seats }, dirs: [{ alias: null, account: null, quota: null },
    { alias: 'team-a', account: A, quota: short5h() }, { alias: 'team-b', account: B, quota: null }],
    sessions: [{ ...RUN('claude'), project: 'pa', seat: 'team-a' }, { ...RUN('claude'), project: 'pb', seat: 'team-b' }] });
  const blocks = text.split(/(?=^## )/m);
  assert.equal(blocks.length, 2, 'the unassigned, idle, logged-out base dir says nothing on a multi-seat machine');
  assert.match(blocks[0], /^## Claude · team\\-a · 40% left[\s\S]*_Team A_[\s\S]*\| 5h \|[\s\S]*\*\*pa\*\*/);
  assert.doesNotMatch(blocks[0], /pb/);
  assert.match(blocks[1], /^## Claude · team\\-b\n[\s\S]*_Team B_[\s\S]*\*\*pb\*\*/);
});

test('renderReport: the base dir joins the seat its login matches; the freshest quota wins', () => {
  const seats = [{ alias: 'team-a', email: 'a@example.com', org: 'Team A', machines: ['m1'] }];
  const text = render({ registry: { seats }, dirs: [{ alias: null, account: ME, quota: short5h() },
    { alias: 'team-a', account: ME, quota: short5h(NOW - 30 * 60000) }],
    sessions: [{ ...RUN('claude'), project: 'base' }, { ...RUN('claude'), project: 'seat', seat: 'team-a' }] });
  assert.equal(text.match(/^## /gm).length, 1);
  assert.doesNotMatch(text, /data .* old/, 'the base dir has the fresher snapshot');
  assert.match(text, /\*\*base\*\*[\s\S]*\*\*seat\*\*/);
});

test('renderReport: a seat dir that is not registered for this machine is a problem', () => {
  const text = render({ registry: REG, dirs: [{ alias: null, account: ME, quota: null }, { alias: 'team-b', account: ME, quota: null }] });
  assert.match(text, /## Claude · team\\-b[\s\S]*seat team\\-b is not registered for m1/);
});
