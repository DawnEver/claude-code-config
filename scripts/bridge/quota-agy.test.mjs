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

test('statusLine quota -> windows per pool (remaining fraction, reset in seconds or at)', () => {
  const now = 1_800_000_000_000;
  const pools = agyPools({ 'gemini-5h': { remaining_fraction: 0.979, reset_in_seconds: 3600 },
    'claude-7d': { remaining_fraction: 0.5, resets_at: now / 1000 + 86400 }, junk: { remaining_fraction: 1 } }, now);
  assert.deepEqual(Object.keys(pools).sort(), ['claude', 'gemini']);
  assert.equal(Math.round(pools.gemini['5h'].used * 10), 21);
  assert.equal(pools.gemini['5h'].resetsAt, now + 3600000);
  assert.equal(pools.claude['7d'].used, 50);
  assert.equal(pools.claude['7d'].resetsAt, now + 86400000);
});

test('teed series become one dashboard account per pool, keyed by the login; a session spends the freshest', () => {
  const dir = tmp();
  const now = Date.now();
  teeAgyUsage({ quota: { 'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3 * 3600 } } }, { email: 'A@x.io', dir, now: now - 1000 });
  teeAgyUsage({ quota: { 'claude-5h': { remaining_fraction: 0.4, reset_in_seconds: 3 * 3600 } } }, { email: 'A@x.io', dir, now });
  const pools = readAgy({ email: 'A@x.io', dir });
  assert.deepEqual(pools.map((p) => p.pool), ['claude', 'gemini']);
  assert.deepEqual(readAgy({ email: 'other@x.io', dir }), []);
  const reader = new AccountReader({ machine: 'm', now: () => now, extraResets: async () => null,
    sources: { seats: () => [], claude: () => [], agy: () => pools } });
  const accounts = reader.read().filter((a) => a.agent === 'agy');
  assert.deepEqual(accounts.map((a) => a.key), ['agy:a@x.io|claude', 'agy:a@x.io|gemini']);
  assert.equal(accounts[0].windows[0].k, '5h');
  assert.equal(Math.round(accounts[0].windows[0].used), 60);
  assert.equal(accountFor({ agent: 'agy', seat: null }, accounts), 'agy:a@x.io|claude');
  // The wire format takes them: agent `agy` is in the vocabulary.
  const push = parseHostPush({ schemaVersion: SCHEMA_VERSION, bootAt: 1, seq: 1, sessions: [{ id: 's', agent: 'agy', status: 'idle', lastActivityAt: now }], accounts });
  assert.equal(push.accounts.filter((a) => a.agent === 'agy').length, 2);
  assert.equal(push.sessions[0]?.agent, 'agy');
});

test('the agy login is the last applyAuthResult in cli.log', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'cli.log'), 'x applyAuthResult: email=old@x.io, authMethod=consumer\ny applyAuthResult: email=new@x.io, authMethod=consumer\n');
  assert.equal(readAgyEmail(dir), 'new@x.io');
  assert.equal(readAgyEmail(tmp()), null);
});

test('the agy status line names model, context and each pool', () => {
  assert.equal(statusText({ model: { display_name: 'Gemini' }, context_window: { used_percentage: 30.4 } }, { gemini: { '5h': { used: 2 }, '7d': { used: 40 } } }), 'Gemini · ctx 30% · gemini 7d 40%');
  assert.equal(statusText(null), 'agy');
});
