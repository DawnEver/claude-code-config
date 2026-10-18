// scripts/dashboard/registry.mjs — the gateway's only state: the last accepted push of each
// host, in memory. An aggregate cache, never an authority: it is rebuilt by the next round of
// pushes, so a gateway restart loses nothing. Time is the gateway's own clock (host clocks
// may disagree): `lastSeen` is when a push arrived, and a host silent for `ttlMs` is offline
// and every session it last reported is `stale`.

import { SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';
import { quotaAlertsFor, quotaView } from './public/view.mjs';

export class Registry {
  constructor({ hosts = [], ttlMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { ttlMs, now });
    this.hosts = new Map(hosts.map((id) => [id, null]));   // configured host id -> last push | null
    this.alerted = new Map();   // account key -> what was last alerted (view.mjs quotaAlertsFor)
  }

  /**
   * Accept a parsed push unless it is not newer than the one held: an older boot, or the same
   * boot's earlier tick. Returns {accepted, alerts}: the quota alerts this push's accounts now
   * warrant, judged once here on the merged view (so an account several hosts report alerts
   * once) and handed to this host to post with its own bot — the Worker holds no bot token.
   */
  accept(hostId, push) {
    const prev = this.hosts.get(hostId);
    // A boot dated ahead of this clock would outrank every later boot: refused (5 min skew).
    if (push.bootAt > this.now() + 300000) return { accepted: false, alerts: [] };
    if (prev && (push.bootAt < prev.bootAt || (push.bootAt === prev.bootAt && push.seq <= prev.seq))) return { accepted: false, alerts: [] };
    this.hosts.set(hostId, { ...push, receivedAt: this.now() });
    const merged = new Map(this.accounts().map((a) => [a.key, a]));
    const alerts = [];
    for (const key of new Set(push.accounts.map((a) => a.key))) {
      const { texts, state } = quotaAlertsFor(this.alerted.get(key), quotaView(merged.get(key), this.now()), this.now());
      this.alerted.set(key, state);
      alerts.push(...texts);
    }
    return { accepted: true, alerts };
  }

  host(id) {
    if (!this.hosts.has(id)) return null;
    const p = this.hosts.get(id);
    const online = !!p && this.now() - p.receivedAt < this.ttlMs;
    return { id, online, lastSeen: p ? new Date(p.receivedAt).toISOString() : null,
      sessions: (p?.sessions ?? []).map((s) => ({ ...s, hostId: id, stale: !online })) };
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

  snapshot() {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(this.now()).toISOString(),
      hosts: [...this.hosts.keys()].sort().map((id) => this.host(id)), accounts: this.accounts() };
  }
}
