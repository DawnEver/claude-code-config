import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingReader, billingEntries, readAccount } from './billing.mjs';
import { parseHostPush, SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';
import { billingView } from '../dashboard/public/view.mjs';

const cache = { providers: { deepseek: { host: 'api.deepseek.com', key_usernames: { session: 'api-key-session' } }, openai: { host: 'api.openai.com', key_usernames: { session: 'api-key-session' } } } };
const getKey = ({ host }) => (host === 'api.deepseek.com' ? { key: 'sk-test' } : { error: 'none' });
const deepseekBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '457.22' }, { currency: 'USD', total_balance: '2.00' }] };

test('billing: a DeepSeek balance per currency, keyed by provider and key fingerprint; the key never leaves', async () => {
  const calls = [];
  const fetch = async (url, opts) => { calls.push([url, opts.headers.Authorization]); return { ok: true, json: async () => deepseekBody }; };
  const a = await readAccount({ provider: 'deepseek', label: null, keyUsername: null }, { cache, getKey, fetch, now: () => 1.7e12 });
  assert.deepEqual(calls, [['https://api.deepseek.com/user/balance', 'Bearer sk-test']]);
  assert.match(a.key, /^deepseek:[a-f0-9]{12}$/);
  assert.deepEqual(a.balances, [{ currency: 'CNY', amount: 457.22 }, { currency: 'USD', amount: 2 }]);
  assert.ok(!JSON.stringify(a).includes('sk-test'));
});

test('billing: no key on this host is no entry; an HTTP failure or a provider without a reader is an error', async () => {
  assert.equal(await readAccount({ provider: 'openai' }, { cache, getKey }), null);
  assert.equal(await readAccount({ provider: 'nope' }, { cache, getKey }), null);
  const failed = await readAccount({ provider: 'deepseek' }, { cache, getKey, fetch: async () => ({ ok: false, status: 401 }) });
  assert.equal(failed.error, 'HTTP 401');
  const unsupported = await readAccount({ provider: 'openai' }, { cache, getKey: () => ({ key: 'k' }) });
  assert.equal(unsupported.error, 'no balance API');
});

test('billing: entries validated; the reader refreshes in the background at most every interval', async () => {
  assert.deepEqual(billingEntries([{ provider: 'deepseek', label: 'main' }, { label: 'x' }, null]), [{ provider: 'deepseek', label: 'main', keyUsername: null }]);
  let t = 0, reads = 0;
  const r = new BillingReader({ entries: [{ provider: 'deepseek' }], everyMs: 1000, now: () => t, readCache: () => cache,
    readOne: async () => { reads++; return { key: 'deepseek:0123456789ab', provider: 'deepseek', label: null, at: 1.7e12, balances: [] }; } });
  assert.deepEqual(r.read(), []);
  await r.pending;
  assert.equal(r.read().length, 1);
  assert.equal(reads, 1);
  t = 1000; r.read(); await r.pending;
  assert.equal(reads, 2);
  assert.deepEqual(new BillingReader({}).read(), [], 'nothing configured: nothing read');
});

test('billing: the push schema bounds entries; the view formats amounts', () => {
  const base = { schemaVersion: SCHEMA_VERSION, bootAt: 1, seq: 1, sessions: [] };
  const p = parseHostPush({ ...base, billing: [{ key: 'deepseek:0123456789ab', at: 1.7e12, balances: [{ currency: 'CNY', amount: 457.22 }, { currency: 'bad', amount: 1 }] },
    { key: 'deepseek:sk-leak', at: 1.7e12, balances: [] }] });
  assert.deepEqual(p.billing, [{ key: 'deepseek:0123456789ab', provider: 'deepseek', label: null, at: 1.7e12, error: null, balances: [{ currency: 'CNY', amount: 457.22 }] }]);
  assert.deepEqual(parseHostPush(base).billing, []);
  const [v] = billingView([{ ...p.billing[0], balances: [{ currency: 'CNY', amount: 457.22 }, { currency: 'USD', amount: 2 }] }], 1.7e12 + 120000);
  assert.equal(v.name, 'DeepSeek');
  assert.equal(v.amounts, '¥457.22 · $2.00');
});
