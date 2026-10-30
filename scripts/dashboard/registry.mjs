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

/** A forge source is read again once its last good reading is this old. */
export const FORGE_EVERY_MS = 5 * 60000;
/** A host given a source to read holds it this long; past it, another host may take it (a host that died). */
export const FORGE_LEASE_MS = 2 * 60000;
/** A host that could not read a source (no token, no route) is not asked for it again within this. */
export const FORGE_SKIP_MS = 30 * 60000;

export class Registry {
  constructor({ hosts = [], ttlMs = 60000, now = Date.now, store = null } = {}) {
    Object.assign(this, { ttlMs, now, store });
    this.hosts = new Map(hosts.map((id) => [id, null]));   // configured host id -> last push | null
    this.alerted = new Map(Object.entries(store?.get('alerted') ?? {}));   // account key -> what was last alerted (quota-model.mjs quotaAlertsFor)
    // Alerts and config changes as data ({at, kind, ...}), newest first; the page words them. An
    // entry with no kind is from before events were data: dropped.
    this.events = (store?.get('events') ?? []).filter((e) => e?.kind);
    this.changes = new Map();   // pending config change id -> {id, key, value, by, at, host?, sentAt?}
    // Forge sources (bridge.forges), the one record of each: its last reading ({at, repos} or
    // {at, error}), the host holding its lease, and hosts that cannot read it until a time. Kept
    // in storage, so a restart neither empties the Code tab nor makes every host read at once.
    this.forges = new Map(Object.entries(store?.get('forges') ?? {}));
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
    const forgeRead = this.#forges(hostId, push.forges ?? { sources: [], readings: [] });
    const configChanges = this.#settle(hostId, push.configResults);
    const merged = new Map(this.accounts().map((a) => [a.key, a]));
    // Alerts are about quota windows: a balance has none.
    for (const key of new Set(push.accounts.filter((a) => a.kind === 'quota').map((a) => a.key))) {
      const { events, state } = quotaAlertsFor(this.alerted.get(key), quotaView(merged.get(key), this.now()));
      this.alerted.set(key, state);
      for (const e of events) this.#event(e);
    }
    this.store?.put('alerted', Object.fromEntries(this.alerted));
    return { accepted: true, configChanges, forgeRead };
  }

  /**
   * Take this host's forge readings, then lease it the sources it is configured for that are due:
   * no good reading within FORGE_EVERY_MS, no live lease, and this host not skipped. One host per
   * source per interval however many are configured for it; a lease a dead host held lapses after
   * FORGE_LEASE_MS. A reading replaces the source's last one whole (idempotent); an error is kept
   * only while there is no good reading, and a host that cannot read is skipped for FORGE_SKIP_MS.
   */
  #forges(hostId, { sources, readings }) {
    const now = this.now();
    for (const x of readings) {
      const f = this.forges.get(x.source) ?? { skip: {} };
      if (f.lease?.host === hostId) delete f.lease;
      if (x.repos) Object.assign(f, { at: x.at, repos: x.repos, by: hostId, error: null });
      else if (x.error) { if (!f.repos) Object.assign(f, { errorAt: x.at, error: x.error }); f.skip[hostId] = now + FORGE_SKIP_MS; }
      else f.skip[hostId] = now + FORGE_SKIP_MS;
      this.forges.set(x.source, f);
    }
    const read = [];
    for (const id of sources) {
      const f = this.forges.get(id) ?? { skip: {} };
      const due = !f.repos || now - f.at >= FORGE_EVERY_MS;
      if (!due || (f.lease && f.lease.until > now) || (f.skip[hostId] ?? 0) > now) continue;
      f.lease = { host: hostId, until: now + FORGE_LEASE_MS };
      this.forges.set(id, f);
      read.push(id);
    }
    if (readings.length || read.length) this.store?.put('forges', Object.fromEntries(this.forges));
    return read;
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
   * An account (a subscription or an API balance) is one, not one per host: reported by several hosts it appears once,
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
    // Subscriptions first, by agent; then API balances, by provider.
    const order = (a) => [a.kind === 'balance' ? 1 : 0, a.agent ?? a.provider, String(a.label ?? a.email)];
    return [...byKey.values()].sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]); });
  }

  /**
   * Every repository of every source's last good reading, newest push first (a repo two sources
   * list appears once). A source never read well shows as its error, so a missing token is seen.
   */
  repos() {
    const byKey = new Map();
    for (const [id, f] of this.forges) {
      if (f.repos) { for (const r of f.repos) if (!byKey.has(r.key) || (byKey.get(r.key).error && !r.error)) byKey.set(r.key, { ...r, hosts: [f.by] }); }
      else if (f.error) {
        const [kind, host, owner, list] = id.split(':');
        for (const name of list ? list.split(',') : [owner]) {
          const key = `${host}/${name}`.toLowerCase();
          if (!byKey.has(key)) byKey.set(key, { key, forge: kind, name, url: `https://${host}/${name}`, at: f.errorAt, error: f.error, pinned: true, hosts: [], branches: [], pulls: [] });
        }
      }
    }
    return [...byKey.values()].sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
  }

  snapshot() {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(this.now()).toISOString(),
      hosts: [...this.hosts.keys()].sort().map((id) => this.host(id)), accounts: this.accounts(), repos: this.repos(), events: this.events,
      configKeys: configKeysMeta(),
      configPending: [...this.changes.values()].map(({ id, key, value, at, host }) => ({ id, key, value, at: new Date(at).toISOString(), host: host ?? null })) };
  }
}
