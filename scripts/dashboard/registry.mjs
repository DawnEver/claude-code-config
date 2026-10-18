// scripts/dashboard/registry.mjs — the gateway's only state: the last accepted push of each
// host, in memory. An aggregate cache, never an authority: it is rebuilt by the next round of
// pushes, so a gateway restart loses nothing. Time is the gateway's own clock (host clocks
// may disagree): `lastSeen` is when a push arrived, and a host silent for `ttlMs` is offline
// and every session it last reported is `stale`.

import { SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';

export class Registry {
  constructor({ hosts = [], ttlMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { ttlMs, now });
    this.hosts = new Map(hosts.map((id) => [id, null]));   // configured host id -> last push | null
  }

  /** Accept a parsed push unless it is not newer than the one held: an older boot, or the same boot's earlier tick. */
  accept(hostId, push) {
    const prev = this.hosts.get(hostId);
    // A boot dated ahead of this clock would outrank every later boot: refused (5 min skew).
    if (push.bootAt > this.now() + 300000) return false;
    if (prev && (push.bootAt < prev.bootAt || (push.bootAt === prev.bootAt && push.seq <= prev.seq))) return false;
    this.hosts.set(hostId, { ...push, receivedAt: this.now() });
    return true;
  }

  host(id) {
    if (!this.hosts.has(id)) return null;
    const p = this.hosts.get(id);
    const online = !!p && this.now() - p.receivedAt < this.ttlMs;
    return { id, online, lastSeen: p ? new Date(p.receivedAt).toISOString() : null,
      sessions: (p?.sessions ?? []).map((s) => ({ ...s, hostId: id, stale: !online })) };
  }

  snapshot() {
    return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date(this.now()).toISOString(),
      hosts: [...this.hosts.keys()].sort().map((id) => this.host(id)) };
  }
}
