import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccountReader, accountFor, quotaOf, agyPools, agyTier, readAgy, readAgyEmail, refreshAgyQuota, teeAgyUsage } from './quota.mjs';
import { parseHostPush, SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';
import { statusText } from '../hooks/agy-statusline.mjs';

const H = 3600000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agyq-'));

test('agy quota tiers: pool and span from bucket id or explicit window (`3p` -> `claude-gpt`)', () => {
  assert.deepEqual(agyTier('gemini-5h'), { pool: 'gemini', windowMs: 5 * H });
  assert.deepEqual(agyTier('3p-weekly', 'weekly'), { pool: 'claude-gpt', windowMs: 168 * H });
  assert.deepEqual(agyTier('claude_weekly'), { pool: 'claude', windowMs: 168 * H });
  assert.deepEqual(agyTier('7d'), { pool: 'agy', windowMs: 168 * H });
  assert.equal(agyTier('gemini'), null);
});

test('agyPools parses both `agy -p /quota --output-format json` groups and statusLine `quota` maps', () => {
  const now = Date.parse('2026-11-19T16:52:29Z');
  const cliQuota = {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.95, reset_time: '2026-11-26T11:47:21Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.99, reset_time: '2026-11-19T21:47:21Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-26T11:01:29Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-19T21:52:29Z' },
            ],
          },
        ],
      },
    },
  };
  const fromCli = agyPools(cliQuota, now);
  assert.deepEqual(Object.keys(fromCli).sort(), ['claude-gpt', 'gemini']);
  assert.equal(Math.round(fromCli.gemini['7d'].used), 5);
  assert.equal(Math.round(fromCli['claude-gpt']['7d'].used), 50);
  assert.equal(Math.round(fromCli['claude-gpt']['5h'].used), 0);

  const fromStatusLine = agyPools({
    quota: {
      'gemini-5h': { remaining_fraction: 0.979, reset_in_seconds: 3600 },
      '3p-weekly': { used_percentage: 42, reset_time: '2026-11-26T11:01:29Z' },
      junk: { remaining_fraction: 1 },
    },
  }, now);
  assert.equal(Math.round(fromStatusLine.gemini['5h'].used * 10), 21);
  assert.equal(fromStatusLine['claude-gpt']['7d'].used, 42);
});

test('teed series and refreshAgyQuota become one dashboard account per pool, keyed by login', async () => {
  const dir = tmp();
  const agyDir = tmp();
  fs.writeFileSync(path.join(agyDir, 'cli.log'), 'applyAuthResult: email=A@example.com, authMethod=consumer\n');
  const now = Date.now();
  await refreshAgyQuota({
    agyBin: 'agy',
    agyDir,
    dir,
    now: () => now,
    exec: (_cmd, _args, _opts, cb) => cb(null, JSON.stringify({
      command: {
        data: {
          groups: [
            { buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.8, reset_time: new Date(now + 3 * H).toISOString() }] },
            { buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0.4, reset_time: new Date(now + 100 * H).toISOString() }] },
          ],
        },
      },
    })),
  });
  const pools = readAgy({ email: 'A@example.com', dir });
  assert.deepEqual(pools.map((p) => p.pool), ['claude-gpt', 'gemini']);
  assert.deepEqual(readAgy({ email: 'other@example.com', dir }), []);
  const reader = new AccountReader({ machine: 'm', now: () => now, extraResets: async () => null,
    sources: { seats: () => [], claude: () => [], agy: () => pools } });
  const accounts = reader.read().filter((a) => a.agent === 'agy');
  assert.deepEqual(accounts.map((a) => a.key), ['agy:a@example.com|claude-gpt', 'agy:a@example.com|gemini']);
  assert.equal(accounts[0].windows[0].k, '7d');
  assert.equal(Math.round(accounts[0].windows[0].used), 60);
  assert.equal(accountFor({ agent: 'agy', seat: null }, accounts), 'agy:a@example.com|claude-gpt');
  const push = parseHostPush({ schemaVersion: SCHEMA_VERSION, bootAt: 1, seq: 1, sessions: [{ id: 's', agent: 'agy', status: 'idle', lastActivityAt: now }], accounts });
  assert.equal(push.accounts.filter((a) => a.agent === 'agy').length, 2);
});

test('readAgyEmail reads statusLine snapshot first and falls back to log/cli-*.log when cli.log is 0 bytes', () => {
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
  assert.deepEqual(accts[0].windows, []);
});

test('the agy status line names model, context and each pool', () => {
  assert.equal(statusText({ model: { display_name: 'Gemini' }, context_window: { used_percentage: 30.4 } }, { gemini: { '5h': { used: 2 }, '7d': { used: 40 } } }), 'Gemini · ctx 30% · gemini 7d 40%');
  assert.equal(statusText(null), 'agy');
});

test('an account lists its windows shortest first, whatever order its source sampled them in', () => {
  const now = Date.now();
  // Antigravity reports the weekly bucket before the 5 h one; Claude Code the other way round.
  const weeklyFirst = { '7d': { used: 40, resetsAt: now + 100 * H, windowMs: 168 * H }, '5h': { used: 10, resetsAt: now + 3 * H, windowMs: 5 * H } };
  const pools = [{ pool: 'gemini', account: { email: 'a@example.com' }, quota: quotaOf([{ from: now, at: now, windows: weeklyFirst }]) }];
  const reader = new AccountReader({ machine: 'm', now: () => now, extraResets: async () => null,
    sources: { seats: () => [], claude: () => [], agy: () => pools } });
  const [account] = reader.read().filter((a) => a.agent === 'agy');
  assert.deepEqual(account.windows.map((w) => w.k), ['5h', '7d']);
});
