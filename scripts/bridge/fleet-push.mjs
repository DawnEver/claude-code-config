// scripts/bridge/fleet-push.mjs — pushes this machine's session snapshot to the fleet gateway
// (docs/fleet-gateway.md). Outbound HTTPS only: the gateway never reaches this machine, and
// the bridge's IPC stays on 127.0.0.1. Fire-and-forget: a push overlapping the previous one
// is skipped, every failure is logged once, nothing is retried, nothing is awaited by the
// Telegram path. `bootAt` (this daemon's start) + `seq` let the gateway drop a delayed push
// from an older daemon or an earlier tick: both are this host's own clock and counter.

import { SCHEMA_VERSION } from '../shared/fleet-schema.mjs';

export class FleetPush {
  constructor({ url, hostToken, machine, sessions, everySeconds = 15, log = () => {}, fetch = globalThis.fetch, timeoutMs = 5000, now = Date.now }) {
    Object.assign(this, { url: `${url}/api/hosts/${machine}/snapshot`, hostToken, machine, sessions, everySeconds, log, fetch, timeoutMs });
    this.bootAt = now();
    this.seq = 0;
    this.inFlight = false;
    this.lastError = null;
  }

  body() {
    return { schemaVersion: SCHEMA_VERSION, bootAt: this.bootAt, seq: ++this.seq, sessions: this.sessions() };
  }

  /** Off the message path: an unref'd timer, never awaited by Telegram routing. */
  start() {
    const timer = setInterval(() => this.tick(), this.everySeconds * 1000);
    timer.unref?.();
    return timer;
  }

  async tick() {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const res = await this.fetch(this.url, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.hostToken}` }, body: JSON.stringify(this.body()) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refused: the gateway holds a push it ranks newer (this host's clock went backwards or ahead).
      if ((await res.json().catch(() => ({}))).accepted !== true) throw new Error('refused as not newer than the one held');
      if (this.lastError) this.log('fleet gateway: push restored');
      this.lastError = null;
      return true;
    } catch (e) {
      // Never log the URL's query or the token: only the outcome.
      const msg = e.name === 'TimeoutError' ? 'timeout' : e.message;
      if (this.lastError !== msg) this.log(`fleet gateway: push failed (${msg}); retrying next tick`);
      this.lastError = msg;
      return false;
    } finally { this.inFlight = false; }
  }
}
