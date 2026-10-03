import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetCard, reportSlot, when, countdown, teeClaudeUsage, windowView, claudeQuota, codexQuota, claudeAccount, seatFor, renderCard } from './fleet.mjs';

const H = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0);
const SEAT = { email: 'a@example.com', org: 'Team A', machines: ['m1'], note: 'reset available by 22/Oct' };
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

test('renderCard: one block per host, headed by the full account it runs as', () => {
  const { text, alerts } = renderCard({ machine: 'm1', registry: REG, account: ME, codexAccount: { email: 'c@example.com', plan: 'plus' },
    claude: short5h(), codex: null,
    sessions: [{ title: 'proj | main | m1 | claude', status: 'Working' }, { title: 'old | main | m1 | codex', status: 'Idle' }], now: NOW });
  assert.match(text, /^<b>m1<\/b>\n\n<b>Claude<\/b> · a@example\.com\n<i>Uni Team A<\/i>\n<code>5h ██████░░░░  60%<\/code>  resets \d\d:\d\d \(3h 0m\)\n<b>\(!\) runs out \d\d:\d\d \(1h 20m\)<\/b>\n<i>reset available by 22\/Oct<\/i>\n\n<b>Codex<\/b> · c@example\.com\n<i>plus<\/i>\n<i>no quota data yet<\/i>\n/);
  assert.match(text, /<b>Running<\/b>\n• proj \| main \| m1 \| claude$/);
  assert.doesNotMatch(text, /old \| main/, 'idle sessions are not listed');
  assert.deepEqual(alerts.map((a) => a.key.split(':')[0]), ['short']);
  assert.match(renderCard({ machine: 'm1', registry: REG, now: NOW }).text, /<b>Codex<\/b> · <i>account unknown<\/i>/);
});

test('renderCard seat checks sit in the Claude block and name the expected seat in full', () => {
  const card = (o) => renderCard({ machine: 'm1', registry: REG, now: NOW, ...o });
  const keys = (o) => card(o).alerts.map((a) => a.key);
  assert.deepEqual(keys({ account: ME }), []);
  assert.deepEqual(keys({ account: { ...ME, email: 'b@example.com' } }), ['seat:account']);
  assert.match(card({ account: { ...ME, org: 'Team B' } }).text, /<i>Team B<\/i>\n[\s\S]*<b>\(!\) wrong team, expected a@example\.com · Team A<\/b>\n\n<b>Codex/);
  assert.deepEqual(keys({ registry: { seats: [{ ...SEAT, orgUuid: 'u2' }] }, account: ME }), ['seat:org']);
  assert.deepEqual(keys({ account: null }), ['seat:none']);
  assert.match(card({ account: null }).text, /<b>Claude<\/b> · not logged in/);
  assert.deepEqual(keys({ machine: 'm9', account: ME }), ['unregistered']);
  assert.deepEqual(renderCard({ machine: 'm9', registry: null, account: ME, now: NOW }).alerts, [], 'no seats configured: no alert');
  assert.match(card({ account: { ...ME, email: 'b@example.com' } }).alerts[0].text, /^m1 Claude: wrong account, expected a@example\.com · Team A$/);
});

test('renderCard: a stale snapshot shows with its time but never alerts; a passed reset reads as such', () => {
  const stale = renderCard({ machine: 'm1', registry: REG, account: ME, claude: short5h(NOW - 20 * 60000), now: NOW });
  assert.match(stale.text, /\n<i>data 20m old<\/i>\n/);
  assert.deepEqual(stale.alerts, []);
  const past = renderCard({ machine: 'm1', registry: REG, account: ME, claude: short5h(), now: NOW + 4 * H });
  assert.match(past.text, /\n<code>5h <\/code> reset \d\d:\d\d, awaiting data/);
  assert.deepEqual(past.alerts, []);
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
  const card = new FleetCard({ telegram, chatId: -1, topicId, machine, now: () => clock.t, stateFile,
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

test('FleetCard reports once per round at its slot, replacing its previous report', async () => {
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

test('FleetCard alerts silently, once per window: a dip does not repeat it, a reset forgets it', async () => {
  const { card, telegram: tg, used, clock } = fleet();
  const alerts = () => tg.sent.filter((m) => /^m1 Codex/.test(m.text));
  await card.tick();
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].alert, undefined, 'no mention');
  used.v = 10; clock.t += 60000; await card.tick();
  used.v = 62; clock.t += 60000; await card.tick();
  assert.equal(alerts().length, 1);
  clock.t = NOW + 3 * H + 1; await card.tick();
  assert.equal(Object.keys(card.state.sent).length, 0);
});

test('FleetCard: overlapping ticks share one run; a failed alert is retried, a sent one is not', async () => {
  const tg = fakeTelegram();
  const { card } = fleet({ telegram: tg });
  await Promise.all([card.tick(), card.tick()]);
  assert.equal(tg.sent.length, 2, 'one report, one alert');
  const other = fakeTelegram();
  other.fail = (text) => /^m1 Codex/.test(text);
  const second = fleet({ telegram: other });
  await assert.rejects(second.card.tick());
  assert.deepEqual(second.card.state.sent, {});
  other.fail = null;
  await second.card.tick();
  assert.equal(other.sent.filter((m) => /^m1 Codex/.test(m.text)).length, 1);
});

test('FleetCard state is per chat/Topic, saved only on change, and holds no email', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  try {
    const stateFile = path.join(dir, 'fleet-card.json');
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

test('renderCard escapes every interpolated value for Telegram HTML', () => {
  const { text } = renderCard({ machine: 'm<1>', registry: { seats: [{ email: 'a@example.com', machines: ['m<1>'], note: 'x & <y>' }] },
    account: { email: 'a@example.com', org: '<Team & Co>' }, sessions: [{ title: 'p<q> | main', status: 'Working' }], now: NOW });
  assert.match(text, /<b>m&lt;1&gt;<\/b>/);
  assert.match(text, /<i>&lt;Team &amp; Co&gt;<\/i>/);
  assert.match(text, /<i>x &amp; &lt;y&gt;<\/i>/);
  assert.match(text, /• p&lt;q&gt; \| main/);
});

test('time formats: both (default), date, countdown — in the card and its alerts', () => {
  assert.deepEqual([countdown(NOW + 4 * 1440 * 60000 + 7 * H, NOW), countdown(NOW + 3 * H + 15 * 60000, NOW), countdown(NOW + 12 * 60000, NOW)], ['4d 7h', '3h 15m', '12m']);
  const card = (timeFormat) => renderCard({ machine: 'm1', registry: { ...REG, timeFormat }, account: ME, claude: short5h(), now: NOW });
  assert.match(card(undefined).text, /resets \d\d:\d\d \(3h 0m\)\n/);
  assert.match(card('date').text, /resets \d\d:\d\d\n/);
  assert.match(card('countdown').text, /resets 3h 0m\n<b>\(!\) runs out 1h 20m<\/b>/);
  assert.match(card('both').text, /resets \d\d:\d\d \(3h 0m\)/);
  assert.match(card('countdown').alerts[0].text, /runs out 1h 20m, resets 3h 0m/);
});
