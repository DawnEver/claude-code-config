// scripts/bridge/balances.mjs — API platform balances as dashboard accounts (docs/dashboard.md "Accounts").
//
// A balance account is a provider plus the credential it is read with: declared in the shared
// settings as `bridge.balances: [{provider, label?, keyUsername?}]`, never with a key. The key is
// the provider's session key from the git credential store (scripts/shared/credential-key.mjs),
// its host from ai-lab's provider cache; a host without the key reports nothing for it.
// Each provider is one reader below: (key) -> {balances: [{currency, amount}]}. A provider with
// no balance endpoint has no reader yet and is reported as unsupported.

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

/**
 * A balance account's identity is its configured entry (provider + label), the one place the
 * account is declared: every host reading it, whatever key it holds, reports the same account.
 */
export const balanceKey = (entry) => `api:${entry.provider}:${entry.label ?? 'default'}`;

/** The account an API-key session on `provider` spends: its unlabelled entry (the launcher's key), else the first. */
export function balanceKeyFor(provider, entries) {
  const mine = entries.filter((e) => e.provider === provider);
  const e = mine.find((x) => !x.label) ?? mine[0];
  return e ? balanceKey(e) : null;
}

/** The configured entries, valid ones only. */
export function balanceEntries(raw) {
  return (Array.isArray(raw) ? raw : []).filter((e) => typeof e?.provider === 'string')
    .map((e) => ({ provider: e.provider, label: typeof e.label === 'string' ? e.label : null,
      keyUsername: typeof e.keyUsername === 'string' ? e.keyUsername : null }));
}

/** One entry -> its dashboard account (kind 'balance'), or null when this host holds no key for it. */
export async function readAccount(entry, { cache, getKey = fetchKey, fetch = globalThis.fetch, now = Date.now } = {}) {
  const row = cache?.providers?.[entry.provider];
  if (!row?.host) return null;
  const username = entry.keyUsername ?? sessionUsername(entry.provider, row).username;
  const got = username ? getKey({ host: row.host, username }) : { error: 'no key username' };
  if (got.error) return null;
  const base = { key: balanceKey(entry), kind: 'balance', provider: entry.provider, label: entry.label, at: now() };
  const reader = READERS[entry.provider];
  if (!reader) return { ...base, balances: [], error: 'no balance API' };
  try {
    const { balances } = await reader({ key: got.key, host: row.host, fetch });
    return { ...base, balances: balances.sort((a, b) => a.currency.localeCompare(b.currency)), error: null };
  } catch (e) { return { ...base, balances: [], error: String(e.message ?? e).slice(0, 200) }; }
}

/**
 * Reads every configured account at most every `everyMs`, in the background: `read()` is
 * synchronous for the dashboard push and returns the last completed reading.
 */
export class BalanceReader {
  constructor({ entries = [], everyMs = 15 * 60000, log = () => {}, now = Date.now, readCache = () => readProviderCache().cache, readOne = readAccount }) {
    Object.assign(this, { entries, everyMs, log, now, readCache, readOne });
    this.last = [];
    this.at = -Infinity;
    this.pending = null;
  }

  read() {
    if (this.entries.length && !this.pending && this.now() - this.at >= this.everyMs) {
      this.pending = this.refresh().catch((e) => this.log(`balances: ${e.message}`))
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
