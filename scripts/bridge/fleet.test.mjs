import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetReport, planName, reportSlot, when, countdown, teeClaudeUsage, windowView, claudeQuota, codexQuota, claudeAccount, seatFor, renderReport } from './fleet.mjs';

const H = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0);
const SEAT = { email: 'a@example.com', org: 'Team A', machines: ['m1'] };
const REG = { seats: [SEAT] };
const ME = { email: 'a@example.com', org: 'Uni Team A', orgUuid: 'u1' };
const short5h = (at = NOW) => claudeQuota({ at, five_hour: { used_percentage: 60, resets_at: (NOW + 3 * H) / 1000 } });

test('windowView projects exhaustion from the average pace since the window opened', () => {
  // 5h window, 4h elapsed, 80% used -> 20%/h -> out exactly at reset: not short.
  const even = windowView({ used: 80, resetsAt: NOW + H, windowMs: 5 * H, at: NOW });
  assert.deepEqual([Math.round(even.perHour), even.short, even.pace], [20, false, 80]);
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

test('claudeAccount reads only the oauth identity; seatFor survives a malformed registry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  try {
    const f = path.join(dir, '.claude.json');
    fs.writeFileSync(f, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', organizationName: 'Team A', organizationUuid: 'u1' } }));
    assert.deepEqual(claudeAccount(f), { email: 'a@example.com', org: 'Team A', orgUuid: 'u1' });
    assert.equal(claudeAccount(path.join(dir, 'missing.json')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(seatFor(REG, 'm1').email, 'a@example.com');
  assert.equal(seatFor(REG, 'm9'), null);
  for (const bad of [null, {}, { seats: 'x' }, { seats: [null, 3, { machines: 'm1' }] }]) assert.equal(seatFor(bad, 'm1'), null);
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
    read: { registry: () => ({ ...REG, order: ['m0', 'm1'] }), account: () => ME, claudeUsage: () => null } });
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
    read: { registry: () => REG, account: () => ME, claudeUsage: () => null } });
  await card.tick(); clock.t += 60000; await card.tick();
  assert.equal(calls, 1);
});


const RUN = (agent, status = 'Working') => ({ agent, project: 'proj-x', branch: 'main', status });
const render = (o) => renderReport({ machine: 'm1', registry: REG, account: ME, now: NOW, ...o });

test('renderReport: no machine title; the heading is the verdict, then the warning, then the account', () => {
  const text = render({ claude: short5h(), sessions: [RUN('claude')] });
  assert.match(text, /^## Claude · 40% left\n\n\*\*\(\\!\) 5h runs out \d\d:\d\d \\\(1h 20m\\\) · resets \d\d:\d\d \\\(3h 0m\\\)\*\*\n\n`a@example\.com` · _Uni Team A_\n\n/);
  assert.doesNotMatch(text, /m1/, 'the posting bot already names the machine');
  assert.match(text, /\| 5h \| `████┃█░░░░` 60% \/ 40% \| \d\d:\d\d \\\(3h 0m\\\) \|/);
  assert.match(text, /\n- \*\*proj\\-x\*\* · main$/);
});

test('renderReport shows a host only when it runs something, has a reset to act on, or a seat problem', () => {
  assert.equal(render({ sessions: [RUN('claude', 'Idle'), RUN('codex', 'Unknown')] }), null, 'idle and unobserved are not running');
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
  assert.deepEqual(warn({ machine: 'm9' }), ['**(\\!) m9 is not in bridge\\.fleet\\.seats**']);
  assert.equal(render({ machine: 'm9', registry: null }), null, 'no seats configured: nothing to check');
});

test('renderReport: stale data says how old; a passed reset reads as such; values are Markdown-escaped', () => {
  assert.match(render({ claude: short5h(NOW - 20 * 60000), sessions: [RUN('claude')] }), /\n\n_data 20m old_/);
  assert.match(render({ claude: short5h(), sessions: [RUN('claude')], now: NOW + 4 * H }), /\| 5h \| — \| reset \d\d:\d\d, awaiting data \|/);
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
    read: { registry: () => REG, account: () => ME, claudeUsage: () => null } });
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
