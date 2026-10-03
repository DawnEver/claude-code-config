import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexState, claudeState, fetchExtraResets } from './extra-resets.mjs';

const NOW = Date.UTC(2026, 9, 3, 12, 0);

test('codexState: latest applied (regular) reset and an announced one; banked events are not listed', () => {
  const s = codexState([
    { id: 'b', reset_type: 'banked', announced_at: '2026-10-02T23:00:00Z', source: { url: 'u-b' } },
    { id: 'r1', reset_type: 'regular', announced_at: '2026-09-26T18:00:00Z', source: { url: 'u-1' } },
    { id: 'r2', reset_type: 'regular', announced_at: '2026-10-02T21:18:48Z', source: { url: 'u-2' } },
  ], { scheduled_reset: { id: 's', scheduled_at: '2026-10-04T18:00:00Z' } });
  assert.deepEqual(s.applied, { type: 'regular', at: Date.parse('2026-10-02T21:18:48Z'), url: 'u-2' });
  assert.equal(s.scheduled.at, Date.parse('2026-10-04T18:00:00Z'));
  assert.deepEqual(s.banked, []);
  assert.equal(codexState(null, null).applied, null);
});

test('claudeState: confirmed only; unexpired banked offers soonest first; announced reset', () => {
  const resets = [
    { id: 'a', kind: 'usage_reset', event_status: 'confirmed', announced_at: '2026-09-04T20:08:45Z', audience: { statement: 'Max plans' }, url: 'u-a' },
    { id: 'x', kind: 'usage_reset', event_status: 'ambiguous', announced_at: '2026-10-01T00:00:00Z' },
  ];
  const status = {
    announced_reset: { id: 'n', event_status: 'confirmed', announced_on: '2026-10-05' },
    reset_offers: [
      { id: 'late', kind: 'credit', event_status: 'confirmed', announced_on: '2026-09-22', reset_offer: { expires_on: '2026-10-30' } },
      { id: 'soon', kind: 'credit', event_status: 'confirmed', announced_on: '2026-09-22', reset_offer: { expires_on: '2026-10-22' } },
      { id: 'gone', kind: 'credit', event_status: 'confirmed', announced_on: '2026-09-01', reset_offer: { expires_on: '2026-10-01' } },
    ],
  };
  const s = claudeState(resets, status, NOW);
  assert.deepEqual([s.applied.scope, s.applied.url], ['Max plans', 'u-a']);
  assert.equal(s.scheduled.at, Date.parse('2026-10-05'));
  assert.deepEqual(s.banked.map((e) => e.expires), [Date.parse('2026-10-22'), Date.parse('2026-10-30')]);
});

test('fetchExtraResets: one failing source reads as null and is logged; the other still counts', async () => {
  const logs = [];
  const fetch = async (url) => (url.includes('clauderesets')
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ data: url.endsWith('/resets') ? [{ id: 'r', reset_type: 'regular', announced_at: '2026-10-02T21:18:48Z' }] : {} }) });
  const x = await fetchExtraResets({ fetch, now: NOW, log: (m) => logs.push(m) });
  assert.equal(x.Claude, null);
  assert.equal(x.Codex.applied.at, Date.parse('2026-10-02T21:18:48Z'));
  assert.match(logs[0], /Claude: HTTP 503/);
});
