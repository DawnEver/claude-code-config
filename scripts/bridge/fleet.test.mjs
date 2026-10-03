import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetCard, teeClaudeUsage, windowView, claudeQuota, codexQuota, claudeAccount, seatFor, renderCard } from './fleet.mjs';

const H = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0);
const SEAT = { name: 'A', email: 'a@example.com', org: 'Team A', machines: ['m1'] };
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
  assert.equal(seatFor(REG, 'm1').name, 'A');
  assert.equal(seatFor(REG, 'm9'), null);
  for (const bad of [null, {}, { seats: 'x' }, { seats: [null, 3, { machines: 'm1' }] }]) assert.equal(seatFor(bad, 'm1'), null);
});

test('renderCard: seat, quota and sessions, never an email', () => {
  const { text, alerts } = renderCard({ machine: 'm1', registry: REG, account: ME, claude: short5h(), codex: null,
    sessions: [{ title: 'proj | main | m1 | claude', status: 'Working' }], now: NOW });
  assert.match(text, /^m1 · A \(Uni Team A\)/);
  assert.match(text, /Claude 5h 60% · 30%\/h · resets \d\d:\d\d · out \d\d:\d\d \(!\)/);
  assert.match(text, /Codex: no quota data yet/);
  assert.match(text, /proj \| main \| m1 \| claude · Working/);
  assert.doesNotMatch(text + alerts.map((a) => a.text).join(), /example\.com/);
  assert.deepEqual(alerts.map((a) => a.key.split(':')[0]), ['short']);
});

test('renderCard seat checks: wrong account, wrong org, uuid pin, no login, unregistered only with a registry', () => {
  const keys = (o) => renderCard({ machine: 'm1', registry: REG, now: NOW, ...o }).alerts.map((a) => a.key);
  assert.deepEqual(keys({ account: ME }), []);
  assert.deepEqual(keys({ account: { ...ME, email: 'b@example.com' } }), ['seat:b@example.com']);
  assert.match(renderCard({ machine: 'm1', registry: REG, account: { ...ME, org: 'Team B' }, now: NOW }).text, /Claude org is Team B, expected Team A/);
  assert.deepEqual(keys({ registry: { seats: [{ ...SEAT, orgUuid: 'u2' }] }, account: ME }), ['seat:u1']);
  assert.deepEqual(keys({ account: null }), ['seat:none']);
  assert.deepEqual(keys({ machine: 'm9', account: ME }), ['unregistered']);
  assert.deepEqual(renderCard({ machine: 'm9', registry: null, account: ME, now: NOW }).alerts, [], 'no fleet.json: no alert');
});

test('renderCard: a stale snapshot shows with its time but never alerts; a passed reset reads as such', () => {
  const stale = renderCard({ machine: 'm1', registry: REG, account: ME, claude: short5h(NOW - 20 * 60000), now: NOW });
  assert.match(stale.text, /as of \d\d:\d\d, stale/);
  assert.deepEqual(stale.alerts, []);
  const past = renderCard({ machine: 'm1', registry: REG, account: ME, claude: short5h(), now: NOW + 4 * H });
  assert.match(past.text, /Claude 5h reset \d\d:\d\d, no newer data/);
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

test('FleetCard edits one message in place and alerts only on a new alert key', async () => {
  const sent = [], edits = [];
  const telegram = {
    sendMessage: async (chat, text, opts) => { sent.push({ chat, text, ...opts }); return [{ message_id: sent.length }]; },
    editMessageText: async (chat, id, text) => { edits.push({ id, text }); },
  };
  let used = 60;
  const card = new FleetCard({ telegram, chatId: -1, topicId: 9, machine: 'm1', alertIds: [42], now: () => NOW,
    sessions: () => [{ title: 'p | main | m1 | codex', status: 'Idle' }],
    codexQuota: () => ({ limits: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: (NOW + 3 * H) / 1000 } }, at: NOW }),
    read: { registry: () => REG, account: () => ME, claudeUsage: () => null } });
  await card.tick();
  assert.equal(sent.length, 2, 'card + one short alert');
  assert.deepEqual([sent[0].threadId, sent[1].alert], [9, [42]]);
  await card.tick();
  assert.deepEqual([sent.length, edits.length], [2, 0], 'unchanged: no writes');
  used = 61;
  await card.tick();
  assert.deepEqual([sent.length, edits.length, edits[0].id], [2, 1, 1], 'changed: edited in place; same alert not repeated');
  used = 10; await card.tick();
  used = 62; await card.tick();
  assert.equal(sent.length, 3, 'an alert that cleared and returns is posted again');
});
