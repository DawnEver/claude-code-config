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

test('renderReport: one block per host, headed by the full account it runs as', () => {
  const text = renderReport({ machine: 'm1', registry: REG, account: ME, codexAccount: { email: 'c@example.com', plan: 'plus' },
    claude: short5h(), codex: null,
    sessions: [{ title: 'proj | main | m1 | claude', status: 'Working' }, { title: 'old | main | m1 | codex', status: 'Idle' }], now: NOW });
  assert.match(text, /^<b>m1<\/b>\n\n<b>Claude<\/b> · a@example\.com\n<i>Uni Team A<\/i>\n<code>5h ██████░░░░  60%<\/code>  resets \d\d:\d\d \(3h 0m\)\n<b>\(!\) runs out \d\d:\d\d \(1h 20m\)<\/b>\n\n<b>Codex<\/b> · c@example\.com\n<i>Plus<\/i>\n<i>no quota data yet<\/i>\n/);
  assert.match(text, /<b>Running<\/b>\n• proj \| main \| m1 \| claude$/);
  assert.doesNotMatch(text, /old \| main/, 'idle sessions are not listed');
  assert.match(renderReport({ machine: 'm1', registry: REG, now: NOW }), /<b>Codex<\/b> · <i>account unknown<\/i>/);
});

test('renderReport seat checks are (!) lines of the Claude block naming the expected seat in full', () => {
  const card = (o) => renderReport({ machine: 'm1', registry: REG, now: NOW, ...o });
  const warnings = (o) => card(o).match(/\(!\) [^<]*/g) ?? [];
  assert.deepEqual(warnings({ account: ME }), []);
  assert.deepEqual(warnings({ account: { ...ME, email: 'b@example.com' } }), ['(!) wrong account, expected a@example.com · Team A']);
  assert.match(card({ account: { ...ME, org: 'Team B' } }), /<i>Team B<\/i>\n[\s\S]*<b>\(!\) wrong team, expected a@example\.com · Team A<\/b>\n\n<b>Codex/);
  assert.deepEqual(warnings({ registry: { seats: [{ ...SEAT, orgUuid: 'u2' }] }, account: ME }), ['(!) wrong team, expected a@example.com · Team A']);
  assert.deepEqual(warnings({ account: null }), ['(!) no subscription login, expected a@example.com · Team A']);
  assert.match(card({ account: null }), /<b>Claude<\/b> · not logged in/);
  assert.deepEqual(warnings({ machine: 'm9', account: ME }), ['(!) m9 is not in bridge.fleet.seats']);
  assert.deepEqual(warnings({ machine: 'm9', registry: null, account: ME }), [], 'no seats configured: nothing to check');
});

test('renderReport: a stale snapshot says how old it is; a passed reset reads as such', () => {
  assert.match(renderReport({ machine: 'm1', registry: REG, account: ME, claude: short5h(NOW - 20 * 60000), now: NOW }), /\n<i>data 20m old<\/i>\n/);
  assert.match(renderReport({ machine: 'm1', registry: REG, account: ME, claude: short5h(), now: NOW + 4 * H }), /\n<code>5h <\/code> reset \d\d:\d\d, awaiting data/);
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
    sessions: () => [{ title: 'p | main | m1 | codex', status: 'Working' }],
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
  const reports = () => tg.sent.filter((m) => m.html);
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

test('renderReport escapes every interpolated value for Telegram HTML', () => {
  const text = renderReport({ machine: 'm<1>', registry: { seats: [{ email: 'a@example.com', machines: ['m<1>'] }] },
    account: { email: 'a@example.com', org: '<Team & Co>' }, sessions: [{ title: 'p<q> | main', status: 'Working' }], now: NOW });
  assert.match(text, /<b>m&lt;1&gt;<\/b>/);
  assert.match(text, /<i>&lt;Team &amp; Co&gt;<\/i>/);
  assert.match(text, /• p&lt;q&gt; \| main/);
});

test('renderReport shows Codex reset credits, each with its expiry, soonest first', () => {
  const card = (rc) => renderReport({ machine: 'm1', registry: REG, account: ME, codexResetCredits: rc, now: NOW });
  assert.match(card({ availableCount: 3, credits: [{ expiresAt: (NOW + 50 * H) / 1000 }, { expiresAt: (NOW + 20 * H) / 1000 }, { expiresAt: null }] }),
    /<code>reset credits: 3<\/code>\n  expires \d\d\/Oct \d\d:\d\d \(20h 0m\)\n  expires \d\d\/Oct \d\d:\d\d \(2d 2h\)\n  no expiry\n/);
  assert.match(card({ availableCount: 0, credits: [] }), /<code>reset credits: 0<\/code>\n/);
  assert.doesNotMatch(card(null), /reset credits/);
});

test('planName shows the sold name for wire plan ids', () => {
  assert.deepEqual([planName('self_serve_business_prolite'), planName('plus'), planName('edu_plus')], ['Business Premium', 'Plus', 'Edu Plus']);
});

test('renderReport: extra resets sit in their host block as state', () => {
  const extra = {
    Claude: { applied: { at: NOW - 29 * 24 * H, scope: 'Max plans', url: 'https://c/a' }, scheduled: null, banked: [{ id: 'opus', name: 'Opus 5.5', expires: NOW + 18 * 24 * H }] },
    Codex: { applied: { at: NOW - 19 * H, url: 'https://x/b' }, scheduled: { at: NOW + 2 * H, url: null }, banked: [] },
  };
  const text = renderReport({ machine: 'm1', registry: REG, account: ME, extra, now: NOW });
  assert.match(text, /<code>banked reset \(Opus 5\.5\) · use by \d\d\/Oct \d\d:\d\d \(18d 0h\)<\/code>\n<i><a href="https:\/\/c\/a">last extra reset<\/a> \d\d\/Sep \d\d:\d\d \(29d 0h ago\) · Max plans<\/i>\n\n<b>Codex/);
  assert.match(text, /<b>extra reset announced<\/b> · \d\d:\d\d \(2h 0m\)\n<i><a href="https:\/\/x\/b">last extra reset<\/a> \d\d\/Oct \d\d:\d\d \(19h 0m ago\)<\/i>/);
  assert.doesNotMatch(renderReport({ machine: 'm1', registry: REG, account: ME, now: NOW }), /extra reset/);
  assert.doesNotMatch(renderReport({ machine: 'm1', registry: { seats: [{ ...SEAT, claimed: ['opus'] }] }, account: ME, extra, now: NOW }), /banked reset/, 'a claimed reset is not offered');
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

test('time formats: both (default), date, countdown', () => {
  assert.deepEqual([countdown(NOW + 4 * 1440 * 60000 + 7 * H, NOW), countdown(NOW + 3 * H + 15 * 60000, NOW), countdown(NOW + 12 * 60000, NOW), countdown(NOW - 19 * H, NOW)], ['4d 7h', '3h 15m', '12m', '19h 0m ago']);
  const card = (timeFormat) => renderReport({ machine: 'm1', registry: { ...REG, timeFormat }, account: ME, claude: short5h(), now: NOW });
  assert.match(card(undefined), /resets \d\d:\d\d \(3h 0m\)\n/);
  assert.match(card('date'), /resets \d\d:\d\d\n/);
  assert.match(card('countdown'), /resets 3h 0m\n<b>\(!\) runs out 1h 20m<\/b>/);
  assert.match(card('both'), /resets \d\d:\d\d \(3h 0m\)/);
});
