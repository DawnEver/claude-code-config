import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccountReader, accountFor, agyPools, agyTier, readAgy, readAgyEmail, teeAgyUsage } from './quota.mjs';
import { parseHostPush, SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';
import { statusText } from '../hooks/agy-statusline.mjs';

const H = 3600000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agyq-'));

test('agy quota tiers: pool and span from the name', () => {
  assert.deepEqual(agyTier('gemini-5h'), { pool: 'gemini', windowMs: 5 * H });
  assert.deepEqual(agyTier('claude_weekly'), { pool: 'claude', windowMs: 168 * H });
  assert.deepEqual(agyTier('7d'), { pool: 'agy', windowMs: 168 * H });
  assert.equal(agyTier('gemini'), null);
});

test('statusLine quota -> windows per pool (remaining fraction, used_percentage, ISO reset_time, bucket arrays)', () => {
  const now = 1_800_000_000_000;
  const pools = agyPools({ 'gemini-5h': { remaining_fraction: 0.979, reset_in_seconds: 3600 },
    'claude-7d': { remaining_fraction: 0.5, resets_at: now / 1000 + 86400 }, junk: { remaining_fraction: 1 } }, now);
  assert.deepEqual(Object.keys(pools).sort(), ['claude', 'gemini']);
  assert.equal(Math.round(pools.gemini['5h'].used * 10), 21);
  assert.equal(pools.gemini['5h'].resetsAt, now + 3600000);
  assert.equal(pools.claude['7d'].used, 50);
  assert.equal(pools.claude['7d'].resetsAt, now + 86400000);
  const buckets = agyPools({ quota_buckets: [
    { quota_bucket_name: 'claude', remaining_fraction: 0.25, reset_time: new Date(now + 4 * H).toISOString() },
    { name: 'Gemini Pro', used_percentage: 40, reset_time: new Date(now + 3 * H).toISOString() },
  ] }, now);
  assert.equal(buckets.claude['5h'].used, 75);
  assert.equal(buckets['gemini-pro']['5h'].used, 40);
});

test('teed series become one dashboard account per pool, keyed by the login; a session spends the freshest', () => {
  const dir = tmp();
  const now = Date.now();
  teeAgyUsage({ quota: { 'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3 * 3600 } } }, { email: 'A@example.com', dir, now: now - 1000 });
  teeAgyUsage({ quota: { 'claude-5h': { remaining_fraction: 0.4, reset_in_seconds: 3 * 3600 } } }, { email: 'A@example.com', dir, now });
  const pools = readAgy({ email: 'A@example.com', dir });
  assert.deepEqual(pools.map((p) => p.pool), ['claude', 'gemini']);
  assert.deepEqual(readAgy({ email: 'other@example.com', dir }), []);
  const reader = new AccountReader({ machine: 'm', now: () => now, extraResets: async () => null,
    sources: { seats: () => [], claude: () => [], agy: () => pools } });
  const accounts = reader.read().filter((a) => a.agent === 'agy');
  assert.deepEqual(accounts.map((a) => a.key), ['agy:a@example.com|claude', 'agy:a@example.com|gemini']);
  assert.equal(accounts[0].windows[0].k, '5h');
  assert.equal(Math.round(accounts[0].windows[0].used), 60);
  assert.equal(accountFor({ agent: 'agy', seat: null }, accounts), 'agy:a@example.com|claude');
  // The wire format takes them: agent `agy` is in the vocabulary.
  const push = parseHostPush({ schemaVersion: SCHEMA_VERSION, bootAt: 1, seq: 1, sessions: [{ id: 's', agent: 'agy', status: 'idle', lastActivityAt: now }], accounts });
  assert.equal(push.accounts.filter((a) => a.agent === 'agy').length, 2);
  assert.equal(push.sessions[0]?.agent, 'agy');
});

test('the agy login falls back to log/cli-*.log when cli.log is 0 bytes, and surfaces an authenticated account before first sample', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'cli.log'), '');
  fs.mkdirSync(path.join(dir, 'log'));
  fs.writeFileSync(path.join(dir, 'log', 'cli-20261119_120000.log'), 'I1119 applyAuthResult: email=live@example.com, authMethod=consumer\n');
  assert.equal(readAgyEmail(dir), 'live@example.com');
  const reader = new AccountReader({ machine: 'm', now: () => 1_800_000_000_000, extraResets: async () => null,
    sources: { seats: () => [], claude: () => [], agy: () => [], agyEmail: () => readAgyEmail(dir) } });
  const accts = reader.read().filter((a) => a.agent === 'agy');
  assert.equal(accts.length, 1);
  assert.equal(accts[0].key, 'agy:live@example.com');
  assert.equal(accts[0].email, 'live@example.com');
  assert.deepEqual(accts[0].windows, []);
  assert.equal(accountFor({ agent: 'agy', seat: null }, accts), 'agy:live@example.com');
});

test('the agy status line names model, context and each pool', () => {
  assert.equal(statusText({ model: { display_name: 'Gemini' }, context_window: { used_percentage: 30.4 } }, { gemini: { '5h': { used: 2 }, '7d': { used: 40 } } }), 'Gemini · ctx 30% · gemini 7d 40%');
  assert.equal(statusText(null), 'agy');
});
