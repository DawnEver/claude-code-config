// scripts/bridge/billing.mjs — API platform balances for the dashboard (docs/dashboard.md "Billing").
//
// A billing account is a provider plus the credential it is read with: declared in the shared
// settings as `bridge.billing: [{provider, label?, keyUsername?}]`, never with a key. The key is
// the provider's session key from the git credential store (scripts/shared/credential-key.mjs),
// its host from ai-lab's provider cache; a host without the key reports nothing for it.
// Each provider is one reader below: (key) -> {balances: [{currency, amount}]}. A provider with
// no balance endpoint has no reader yet and is reported as unsupported.

import { createHash } from 'crypto';
import { fetchKey, sessionUsername } from '../shared/credential-key.mjs';
import { readProviderCache } from '../shared/provider-cache.mjs';

const TIMEOUT_MS = 15000;   // a hung request must not stall every later refresh

const json = async (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** provider -> async ({key, host, fetch}) -> {balances: [{currency, amount}]}. */
export const READERS = {
  // https://api-docs.deepseek.com/api/get-user-balance
  async deepseek({ key, host, fetch }) {
    const body = await json(await fetch(`https://${host}/user/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
    return { balances: (body.balance_infos ?? []).map((b) => ({ currency: String(b.currency), amount: Number(b.total_balance) }))
      .filter((b) => Number.isFinite(b.amount)) };
  },
};

/** The dashboard's identity of an account: provider + key fingerprint, so hosts holding the same key merge. */
const accountKey = (provider, key) => `${provider}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

/** The configured entries, valid ones only. */
export function billingEntries(raw) {
  return (Array.isArray(raw) ? raw : []).filter((e) => typeof e?.provider === 'string')
    .map((e) => ({ provider: e.provider, label: typeof e.label === 'string' ? e.label : null,
      keyUsername: typeof e.keyUsername === 'string' ? e.keyUsername : null }));
}

/** One entry -> its dashboard account, or null when this host holds no key for it. */
export async function readAccount(entry, { cache, getKey = fetchKey, fetch = globalThis.fetch, now = Date.now } = {}) {
  const row = cache?.providers?.[entry.provider];
  if (!row?.host) return null;
  const username = entry.keyUsername ?? sessionUsername(entry.provider, row).username;
  const got = username ? getKey({ host: row.host, username }) : { error: 'no key username' };
  if (got.error) return null;
  const base = { key: accountKey(entry.provider, got.key), provider: entry.provider, label: entry.label, at: now() };
  const reader = READERS[entry.provider];
  if (!reader) return { ...base, balances: [], error: 'no balance API' };
  try { return { ...base, ...(await reader({ key: got.key, host: row.host, fetch })) }; }
  catch (e) { return { ...base, balances: [], error: String(e.message ?? e).slice(0, 200) }; }
}

/**
 * Reads every configured account at most every `everyMs`, in the background: `read()` is
 * synchronous for the dashboard push and returns the last completed reading.
 */
export class BillingReader {
  constructor({ entries = [], everyMs = 15 * 60000, log = () => {}, now = Date.now, readCache = () => readProviderCache().cache, readOne = readAccount }) {
    Object.assign(this, { entries, everyMs, log, now, readCache, readOne });
    this.last = [];
    this.at = -Infinity;
    this.pending = null;
  }

  read() {
    if (this.entries.length && !this.pending && this.now() - this.at >= this.everyMs) {
      this.pending = this.refresh().catch((e) => this.log(`billing: ${e.message}`))
        .finally(() => { this.at = this.now(); this.pending = null; });
    }
    return this.last;
  }

  async refresh() {
    const cache = this.readCache();
    const got = await Promise.all(this.entries.map((e) => this.readOne(e, { cache })));
    this.last = got.filter(Boolean);
  }
}
