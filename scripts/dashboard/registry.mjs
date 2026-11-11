// scripts/dashboard/registry.mjs — the gateway's only state. The last accepted push of each
// host is an aggregate cache in memory, never an authority: the next round of pushes rebuilds
// it. What was last alerted (each account's condition, the hosts alerted offline) is history no
// push can rebuild: it lives in `store` (the Durable Object's storage), written only when it
// changes, so a restart never re-alerts a standing condition. An alert is data handed to
// `notify` (notify.mjs words and sends it); the registry keeps no list of them. Time is the
// gateway's own clock (host clocks may disagree): `lastSeen` is when a push arrived, a host
// silent for `ttlMs` is offline and every session it last reported is `stale`, and one silent
// for `offlineAlertMs` is alerted once (sweep).

import { SCHEMA_VERSION, configKeysMeta } from '../shared/dashboard-schema.mjs';
import { quotaAlertsFor, quotaView } from './public/shared/quota-model.mjs';

/** How many alert ids hosts sent are remembered, so a push re-sent after a lost reply alerts once. */
const MAX_SEEN_ALERTS = 200;
/** At most this many banked resets are kept per account. */
export const MAX_BANKED = 10;
/** A change handed to a host that does not report it within this goes to the next host. */
const CHANGE_RETRY_MS = 120000;

/** A forge source is read again once its last good reading is this old. */
export const FORGE_EVERY_MS = 5 * 60000;
/** A host given a source to read holds it this long; past it, another host may take it (a host that died). */
export const FORGE_LEASE_MS = 2 * 60000;
/** A host that could not read a source (no token, no route) is not asked for it again within this. */
const FORGE_SKIP_MS = 30 * 60000;
/** A source no host has declared for this long left every config: it is forgotten. */
export const FORGE_FORGET_MS = 24 * 3600000;

export class Registry {
  constructor({ hosts = [], ttlMs = 60000, offlineAlertMs = 300000, offlineAlertExclude = [], now = Date.now, store = null, notify = () => {} } = {}) {
    Object.assign(this, { ttlMs, offlineAlertMs, now, store, notify });
    this.offlineAlertExclude = new Set(offlineAlertExclude);   // hosts never alerted offline
    this.startedAt = now();   // a host not heard from since this start is counted silent from it
    this.hosts = new Map(hosts.map((id) => [id, null]));   // configured host id -> last push | null
    this.alerted = new Map(Object.entries(store?.get('alerted') ?? {}));   // account key -> what was last alerted (quota-model.mjs quotaAlertsFor)
    this.down = new Map(Object.entries(store?.get('down') ?? {}));   // host id alerted offline -> when (ISO, or null) it was last seen
    this.seenAlerts = [];   // ids of host alerts already sent, newest first (MAX_SEEN_ALERTS)
    this.configLast = new Map();   // config key -> the last outcome a host reported {outcome, value, host, at, error?}
    this.changes = new Map();   // pending config change id -> {id, key, value, by, at, host?, sentAt?}
    // Forge sources (bridge.forges), the one record of each: its last reading ({at, repos} or
    // {at, error}), the host holding its lease, and hosts that cannot read it until a time. Kept
    // in storage, so a restart neither empties the Code tab nor makes every host read at once.
    // Each subscription's banked resets (a one-off full or model reset the vendor granted, to
    // spend before it expires): no API reports them, so a viewer records them here. Account key
    // -> [{id, name, expiresAt, note?}].
    this.banked = new Map(Object.entries(store?.get('banked') ?? {}));
    this.forges = new Map(Object.entries(store?.get('forges') ?? {}).filter(([id]) => id.includes('|')));   // `|` ids only (sourceId)
  }

  /**
   * Accept a parsed push unless it is not newer than the one held: an older boot, or the same
   * boot's earlier tick. Returns {accepted, configChanges, forgeRead}. The quota alerts this push's
   * accounts now warrant are judged once here, on the merged view (so an account several hosts
   * report alerts once); the alerts the host raised itself (a failed turn) are sent too.
   */
  accept(hostId, push) {
    const prev = this.hosts.get(hostId);
    // A boot dated ahead of this clock would outrank every later boot: refused (5 min skew).
    if (push.bootAt > this.now() + 300000) return { accepted: false };
    if (prev && (push.bootAt < prev.bootAt || (push.bootAt === prev.bootAt && push.seq <= prev.seq))) return { accepted: false };
    this.hosts.set(hostId, { ...push, receivedAt: this.now() });
    // Back: watched again, silently (only going offline is alerted).
    if (this.down.has(hostId)) {
      this.down.delete(hostId);
      this.store?.put('down', Object.fromEntries(this.down));
    }
    for (const { id, ...alert } of push.alerts ?? []) {
      if (this.seenAlerts.includes(id)) continue;
      this.seenAlerts = [id, ...this.seenAlerts].slice(0, MAX_SEEN_ALERTS);
      this.#alert({ ...alert, host: hostId });
    }
    const forgeRead = this.#forges(hostId, push.forges ?? { sources: [], readings: [] });
    const configChanges = this.#settle(hostId, push.configResults);
    const merged = new Map(this.accounts().map((a) => [a.key, a]));
    // Alerts are about quota windows: a balance has none.
    let changed = false;
    for (const key of new Set(push.accounts.filter((a) => a.kind === 'quota').map((a) => a.key))) {
      const { events, state } = quotaAlertsFor(this.alerted.get(key), quotaView(merged.get(key), this.now()));
      // Written only when it changed: a push every few seconds must not cost a storage write each.
      if (JSON.stringify(state) !== JSON.stringify(this.alerted.get(key))) { this.alerted.set(key, state); changed = true; }
      for (const e of events) this.#alert(e);
    }
    if (changed) this.store?.put('alerted', Object.fromEntries(this.alerted));
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
      // Why it is not read, kept per host while there is no good reading: no token anywhere must show.
      if (x.repos) Object.assign(f, { at: x.at, repos: x.repos, by: hostId, error: null, unavailable: {} });
      else if (x.error) { if (!f.repos) Object.assign(f, { errorAt: x.at, error: x.error }); f.skip[hostId] = now + FORGE_SKIP_MS; }
      else { (f.unavailable ??= {})[hostId] = x.unavailable; f.errorAt = x.at; f.skip[hostId] = now + FORGE_SKIP_MS; }
      this.forges.set(x.source, f);
    }
    const read = [];
    for (const id of sources) {
      const f = this.forges.get(id) ?? { skip: {} };
      f.declared = now;   // some host's config still names it
      this.forges.set(id, f);
      const due = !f.repos || now - f.at >= FORGE_EVERY_MS;
      if (!due || (f.lease && f.lease.until > now) || (f.skip[hostId] ?? 0) > now) continue;
      f.lease = { host: hostId, until: now + FORGE_LEASE_MS };
      this.forges.set(id, f);
      read.push(id);
    }
    // A source no host has named for FORGE_FORGET_MS was removed from every config: forgotten.
    let forgot = 0;
    for (const [id, f] of this.forges) if (now - (f.declared ?? 0) > FORGE_FORGET_MS) { this.forges.delete(id); forgot++; }
    // Stored whenever the record changed in substance — a reading, a lease, a forgotten source — so a restart sees it.
    if (readings.length || read.length || forgot) this.store?.put('forges', Object.fromEntries(this.forges));
    return read;
  }

  #alert(a) {
    // A send that fails is the notifier's to log; it never fails the push that raised it.
    try { Promise.resolve(this.notify({ at: new Date(this.now()).toISOString(), ...a })).catch(() => {}); } catch {}
  }

  /**
   * Alert once each host silent for offlineAlertMs (a host not heard from since this start is
   * counted from the start); its next push watches it again, without an alert. Returns when the next host
   * would turn silent (ms), or null when every host is already alerted: the caller wakes then,
   * never on a fixed timer, so an idle gateway costs nothing.
   */
  sweep() {
    const now = this.now();
    let next = null, changed = false;
    for (const [id, p] of this.hosts) {
      if (this.down.has(id) || this.offlineAlertExclude.has(id)) continue;
      const due = (p?.receivedAt ?? this.startedAt) + this.offlineAlertMs;
      if (due > now) { next = Math.min(next ?? due, due); continue; }
      const lastSeen = p ? new Date(p.receivedAt).toISOString() : null;
      this.down.set(id, lastSeen);
      changed = true;
      this.#alert({ kind: 'host-offline', host: id, lastSeen });
    }
    if (changed) this.store?.put('down', Object.fromEntries(this.down));
    return next;
  }

  /**
   * A dashboard edit (validated by the caller against CONFIG_KEYS): queued until a host applies
   * it to the shared settings. One pending change per key: a newer request replaces an older one.
   */
  requestChange({ key, value }, by) {
    for (const [id, c] of this.changes) if (c.key === key) this.changes.delete(id);
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.changes.set(id, { id, key, value, by, at: this.now() });
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
      this.configLast.set(c.key, { outcome: r.ok ? 'applied' : 'refused', value: c.value, host: hostId, at: new Date(this.now()).toISOString(), ...(r.ok ? {} : { error: r.error }) });
      if (!r.ok) this.#alert({ kind: 'config-refused', key: c.key, value: c.value, host: hostId, error: r.error });
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
  /**
   * Apply a banked-reset edit (api.mjs parseBankedEdit) to each of `accounts`: `add` one (the
   * same name and expiry is not added twice), `remove` one by id, `drop` one by name and expiry.
   * False, changing nothing, when any of them is not a subscription a host reports. Expired
   * entries are hidden at once and leave storage on the next edit.
   */
  editBanked({ accounts, add = null, remove = null, drop = null }) {
    const known = new Set(this.accounts().filter((a) => a.kind !== 'balance').map((a) => a.key));
    if (!accounts.every((k) => known.has(k))) return false;
    for (const key of accounts) {
      const list = this.liveBanked(key).filter((b) => b.id !== remove && !(drop && b.name === drop.name && b.expiresAt === drop.expiresAt));
      if (add && !list.some((b) => b.name === add.name && b.expiresAt === add.expiresAt)) {
        list.push({ id: crypto.randomUUID().slice(0, 8), name: add.name, expiresAt: add.expiresAt, ...(add.note ? { note: add.note } : {}) });
      }
      if (list.length) this.banked.set(key, list.sort((x, y) => x.expiresAt - y.expiresAt).slice(0, MAX_BANKED)); else this.banked.delete(key);
    }
    for (const [key, list] of this.banked) if (!list.some((b) => b.expiresAt > this.now())) this.banked.delete(key);
    this.store?.put('banked', Object.fromEntries(this.banked));
    return true;
  }

  liveBanked(key) { return (this.banked.get(key) ?? []).filter((b) => b.expiresAt > this.now()); }

  accounts() {
    const byKey = new Map();
    for (const [id, p] of this.hosts) {
      for (const a of p?.accounts ?? []) {
        const held = byKey.get(a.key);
        const hosts = [...(held?.hosts ?? []), id].sort();
        byKey.set(a.key, !held || (a.at ?? 0) > (held.at ?? 0) ? { ...a, hosts } : { ...held, hosts });
      }
    }
    for (const [key, a] of byKey) if (a.kind !== 'balance') byKey.set(key, { ...a, banked: this.liveBanked(key) });
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
      if (f.repos) {
        // Two sources covering one repo: a good reading beats an error, then the newer reading wins.
        for (const r of f.repos) {
          const held = byKey.get(r.key);
          if (!held || (held.error && !r.error) || (!held.error === !r.error && r.at > held.at)) byKey.set(r.key, { ...r, hosts: [f.by] });
        }
        continue;
      }
      const why = f.error ?? (Object.keys(f.unavailable ?? {}).length
        ? `no host can read it: ${Object.entries(f.unavailable).map(([h, w]) => `${h}: ${w}`).join('; ')}` : null);
      if (!why) continue;
      const [kind, host, owner, list] = id.split('|');
      for (const name of list ? list.split(',') : [owner]) {
        const key = `${host}/${name}`.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { key, forge: kind, name, url: `https://${host}/${name}`, at: f.errorAt, error: why, pinned: true, hosts: [], branches: [], pulls: [] });
      }
    }
    return [...byKey.values()].sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
  }

  snapshot() {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(this.now()).toISOString(),
      hosts: [...this.hosts.keys()].sort().map((id) => this.host(id)), accounts: this.accounts(), repos: this.repos(),
      configKeys: configKeysMeta(), configLast: Object.fromEntries(this.configLast),
      configPending: [...this.changes.values()].map(({ id, key, value, at, host }) => ({ id, key, value, at: new Date(at).toISOString(), host: host ?? null })) };
  }
}
