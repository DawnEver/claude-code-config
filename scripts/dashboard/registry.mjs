// scripts/dashboard/registry.mjs — the gateway's only state. The last accepted push of each
// host is an aggregate cache in memory, never an authority: the next round of pushes rebuilds
// it. The events and what each account was last alerted for are history, which no push can
// rebuild: they live in `store` (the Durable Object's storage), so a restart neither loses the
// history nor re-alerts a standing condition. Time is the gateway's own clock (host clocks
// may disagree): `lastSeen` is when a push arrived, and a host silent for `ttlMs` is offline
// and every session it last reported is `stale`.

import { SCHEMA_VERSION, configKeysMeta } from '../shared/dashboard-schema.mjs';
import { quotaAlertsFor, quotaView } from './public/shared/quota-model.mjs';

/** How many past events the dashboard keeps. */
export const MAX_EVENTS = 50;
/** A change handed to a host that does not report it within this goes to the next host. */
export const CHANGE_RETRY_MS = 120000;

export class Registry {
  constructor({ hosts = [], ttlMs = 60000, now = Date.now, store = null } = {}) {
    Object.assign(this, { ttlMs, now, store });
    this.hosts = new Map(hosts.map((id) => [id, null]));   // configured host id -> last push | null
    this.alerted = new Map(Object.entries(store?.get('alerted') ?? {}));   // account key -> what was last alerted (quota-model.mjs quotaAlertsFor)
    // Alerts and config changes as data ({at, kind, ...}), newest first; the page words them. An
    // entry with no kind is from before events were data: dropped.
    this.events = (store?.get('events') ?? []).filter((e) => e?.kind);
    this.changes = new Map();   // pending config change id -> {id, key, value, by, at, host?, sentAt?}
  }

  /**
   * Accept a parsed push unless it is not newer than the one held: an older boot, or the same
   * boot's earlier tick. Returns {accepted, configChanges}. The quota events this push's accounts
   * now warrant are judged once here, on the merged view (so an account several hosts report
   * alerts once), and kept as dashboard events; nothing is posted anywhere.
   */
  accept(hostId, push) {
    const prev = this.hosts.get(hostId);
    // A boot dated ahead of this clock would outrank every later boot: refused (5 min skew).
    if (push.bootAt > this.now() + 300000) return { accepted: false };
    if (prev && (push.bootAt < prev.bootAt || (push.bootAt === prev.bootAt && push.seq <= prev.seq))) return { accepted: false };
    this.hosts.set(hostId, { ...push, receivedAt: this.now() });
    const configChanges = this.#settle(hostId, push.configResults);
    const merged = new Map(this.accounts().map((a) => [a.key, a]));
    for (const key of new Set(push.accounts.map((a) => a.key))) {
      const { events, state } = quotaAlertsFor(this.alerted.get(key), quotaView(merged.get(key), this.now()));
      this.alerted.set(key, state);
      for (const e of events) this.#event(e);
    }
    this.store?.put('alerted', Object.fromEntries(this.alerted));
    return { accepted: true, configChanges };
  }

  #event(e) {
    this.events = [{ at: new Date(this.now()).toISOString(), ...e }, ...this.events].slice(0, MAX_EVENTS);
    this.store?.put('events', this.events);
  }

  /**
   * A dashboard edit (validated by the caller against CONFIG_KEYS): queued until a host applies
   * it to the shared settings. One pending change per key: a newer request replaces an older one.
   */
  requestChange({ key, value }, by) {
    for (const [id, c] of this.changes) if (c.key === key) this.changes.delete(id);
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.changes.set(id, { id, key, value, by, at: this.now() });
    this.#event({ kind: 'config', key, value, outcome: 'requested' });
    return id;
  }

  /**
   * Record what `hostId` reports about the changes it was handed, then hand it every change no
   * host holds (one host applies a change: the shared file syncs it to the rest). A change
   * handed out but not reported within CHANGE_RETRY_MS goes to the next host that pushes.
   */
  #settle(hostId, results = []) {
    for (const r of results) {
      const c = this.changes.get(r.id);
      if (!c || c.host !== hostId) continue;
      this.changes.delete(r.id);
      this.#event({ kind: 'config', key: c.key, value: c.value, outcome: r.ok ? 'applied' : 'refused', host: hostId, ...(r.ok ? {} : { error: r.error }) });
    }
    const out = [];
    for (const c of this.changes.values()) {
      if (c.host && this.now() - c.sentAt < CHANGE_RETRY_MS) continue;   // handed out, still awaiting its report
      Object.assign(c, { host: hostId, sentAt: this.now() });
      out.push({ id: c.id, key: c.key, value: c.value });
    }
    return out;
  }

  host(id) {
    if (!this.hosts.has(id)) return null;
    const p = this.hosts.get(id);
    const online = !!p && this.now() - p.receivedAt < this.ttlMs;
    return { id, online, lastSeen: p ? new Date(p.receivedAt).toISOString() : null,
      sessions: (p?.sessions ?? []).map((s) => ({ ...s, hostId: id, stale: !online })), resources: p?.resources ?? null, config: p?.config ?? null };
  }

  /**
   * Quota is per account, not per host: an account reported by several hosts appears once,
   * as its freshest observation (`at`, the host's sample time), with every host that runs it.
   * An offline host's last report still counts: use only grows until a reset, so an old
   * reading stays a true floor, and the reader marks it by its age.
   */
  accounts() {
    const byKey = new Map();
    for (const [id, p] of this.hosts) {
      for (const a of p?.accounts ?? []) {
        const held = byKey.get(a.key);
        const hosts = [...(held?.hosts ?? []), id].sort();
        byKey.set(a.key, !held || (a.at ?? 0) > (held.at ?? 0) ? { ...a, hosts } : { ...held, hosts });
      }
    }
    return [...byKey.values()].sort((a, b) => a.agent.localeCompare(b.agent) || String(a.label ?? a.email).localeCompare(String(b.label ?? b.email)));
  }

  /** API platform balances, merged like quota: one entry per account, its freshest reading, with every host that reads it. */
  billing() {
    const byKey = new Map();
    for (const [id, p] of this.hosts) {
      for (const b of p?.billing ?? []) {
        const held = byKey.get(b.key);
        const hosts = [...(held?.hosts ?? []), id].sort();
        byKey.set(b.key, !held || b.at > held.at ? { ...b, hosts } : { ...held, hosts });
      }
    }
    return [...byKey.values()].sort((a, b) => a.provider.localeCompare(b.provider) || String(a.label).localeCompare(String(b.label)));
  }

  snapshot() {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(this.now()).toISOString(),
      hosts: [...this.hosts.keys()].sort().map((id) => this.host(id)), accounts: this.accounts(), billing: this.billing(), events: this.events,
      configKeys: configKeysMeta(),
      configPending: [...this.changes.values()].map(({ id, key, value, at, host }) => ({ id, key, value, at: new Date(at).toISOString(), host: host ?? null })) };
  }
}
