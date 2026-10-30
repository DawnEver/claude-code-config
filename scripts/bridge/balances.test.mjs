import test from 'node:test';
import assert from 'node:assert/strict';
import { BalanceReader, balanceKeyFor, balanceEntries, readAccount } from './balances.mjs';
import { parseHostPush, SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';
import { balanceView } from '../dashboard/public/view.mjs';

const cache = { providers: { deepseek: { host: 'api.deepseek.com', key_usernames: { session: 'api-key-session' } }, openai: { host: 'api.openai.com', key_usernames: { session: 'api-key-session' } } } };
const getKey = ({ host }) => (host === 'api.deepseek.com' ? { key: 'sk-test' } : { error: 'none' });
const deepseekBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '457.22' }, { currency: 'USD', total_balance: '2.00' }] };

test('balances: a DeepSeek balance per currency is a balance account keyed by its configured entry; the key never leaves', async () => {
  const calls = [];
  const fetch = async (url, opts) => { calls.push([url, opts.headers.Authorization]); return { ok: true, json: async () => deepseekBody }; };
  const a = await readAccount({ provider: 'deepseek', label: null, keyUsername: null }, { cache, getKey, fetch, now: () => 1.7e12 });
  assert.deepEqual(calls, [['https://api.deepseek.com/user/balance', 'Bearer sk-test']]);
  assert.deepEqual([a.key, a.kind, a.provider], ['api:deepseek:default', 'balance', 'deepseek']);
  assert.deepEqual(a.balances, [{ currency: 'CNY', amount: 457.22 }, { currency: 'USD', amount: 2 }]);
  const lab = await readAccount({ provider: 'deepseek', label: 'lab', keyUsername: 'api-key-lab' }, { cache, getKey, fetch, now: () => 1.7e12 });
  assert.equal(lab.key, 'api:deepseek:lab', 'one key per configured entry, whatever key a host holds');
  assert.equal(balanceKeyFor('deepseek', [{ provider: 'deepseek', label: 'lab' }, { provider: 'deepseek', label: null }]), 'api:deepseek:default');
  assert.ok(!JSON.stringify(a).includes('sk-test'));
});

test('balances: no key on this host is no entry; an HTTP failure or a provider without a reader is an error', async () => {
  assert.equal(await readAccount({ provider: 'openai' }, { cache, getKey }), null);
  assert.equal(await readAccount({ provider: 'nope' }, { cache, getKey }), null);
  const failed = await readAccount({ provider: 'deepseek' }, { cache, getKey, fetch: async () => ({ ok: false, status: 401 }) });
  assert.equal(failed.error, 'HTTP 401');
  const unsupported = await readAccount({ provider: 'openai' }, { cache, getKey: () => ({ key: 'k' }) });
  assert.equal(unsupported.error, 'no balance API');
});

test('balances: entries validated; the reader refreshes in the background at most every interval', async () => {
  assert.deepEqual(balanceEntries([{ provider: 'deepseek', label: 'main' }, { label: 'x' }, null]), [{ provider: 'deepseek', label: 'main', keyUsername: null }]);
  let t = 0, reads = 0;
  const r = new BalanceReader({ entries: [{ provider: 'deepseek' }], everyMs: 1000, now: () => t, readCache: () => cache,
    readOne: async () => { reads++; return { key: 'api:deepseek:default', kind: 'balance', provider: 'deepseek', label: null, at: 1.7e12, balances: [] }; } });
  assert.deepEqual(r.read(), []);
  await r.pending;
  assert.equal(r.read().length, 1);
  assert.equal(reads, 1);
  t = 1000; r.read(); await r.pending;
  assert.equal(reads, 2);
  assert.deepEqual(new BalanceReader({}).read(), [], 'nothing configured: nothing read');
});

test('balances: a balance rides the push as an account; the schema bounds it and the view formats amounts', () => {
  const base = { schemaVersion: SCHEMA_VERSION, bootAt: 1, seq: 1, sessions: [] };
  const balance = (key, extra = {}) => ({ key, kind: 'balance', provider: 'deepseek', at: 1.7e12, ...extra });
  const p = parseHostPush({ ...base, accounts: [balance('api:deepseek:default', { balances: [{ currency: 'CNY', amount: 457.22 }, { currency: 'bad', amount: 1 }] }),
    balance('api:deepseek:sk-leak extra'), balance('api:other:default'), balance('deepseek:0123456789ab')] });
  assert.deepEqual(p.accounts, [{ key: 'api:deepseek:default', kind: 'balance', provider: 'deepseek', label: null, at: 1.7e12, error: null, balances: [{ currency: 'CNY', amount: 457.22 }] }]);
  const v = balanceView({ ...p.accounts[0], balances: [{ currency: 'CNY', amount: 457.22 }, { currency: 'USD', amount: 2 }] });
  assert.deepEqual([v.amounts, v.verdict, v.left, v.windows], ['¥457.22 · $2.00', 'ok', null, []]);
});
