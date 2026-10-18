// scripts/bridge/dashboard-push.mjs — pushes this machine's session snapshot to the dashboard
// (docs/dashboard.md). Outbound HTTPS only: the gateway never reaches this machine, and
// the bridge's IPC stays on 127.0.0.1. Fire-and-forget: a push overlapping the previous one
// is skipped, every failure is logged once, nothing is retried, nothing is awaited by the
// Telegram path. `bootAt` (this daemon's start) + `seq` let the gateway drop a delayed push
// from an older daemon or an earlier tick: both are this host's own clock and counter.

import { SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';

export class DashboardPush {
  constructor({ url, hostToken, machine, sessions, accounts = () => [], config = () => null, onAlerts = () => {}, onConfigChanges = () => [], everySeconds = 15, log = () => {}, fetch = globalThis.fetch, timeoutMs = 5000, now = Date.now }) {
    Object.assign(this, { url: `${url}/api/hosts/${machine}/snapshot`, hostToken, machine, sessions, accounts, config, onAlerts, onConfigChanges, everySeconds, log, fetch, timeoutMs });
    this.bootAt = now();
    this.seq = 0;
    this.inFlight = false;
    this.lastError = null;
    this.results = [];   // outcomes of config changes applied here, reported on the next push
  }

  body() {
    // Accounts first: a session is labelled with the account it spends (sessions(accounts)).
    const accounts = this.accounts();
    return { schemaVersion: SCHEMA_VERSION, bootAt: this.bootAt, seq: ++this.seq, sessions: this.sessions(accounts), accounts,
      config: this.config(), configResults: this.results };
  }

  /** Off the message path: an unref'd timer, never awaited by Telegram routing. */
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.everySeconds * 1000);
    this.timer.unref?.();
    return this.timer;
  }

  /** A new push interval takes effect at once (a dashboard edit, reloaded live). */
  every(seconds) {
    if (seconds === this.everySeconds) return;
    this.everySeconds = seconds;
    if (this.timer) this.start();
  }

  async tick() {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const res = await this.fetch(this.url, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.hostToken}` }, body: JSON.stringify(this.body()) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refused: the gateway holds a push it ranks newer (this host's clock went backwards or ahead).
      const reply = await res.json().catch(() => ({}));
      if (reply.accepted !== true) throw new Error('refused as not newer than the one held');
      this.results = [];   // delivered with this push
      // Changes the gateway hands this host: applied (and validated again) by the daemon.
      const changes = (Array.isArray(reply.configChanges) ? reply.configChanges : []).filter((c) => typeof c?.id === 'string');
      if (changes.length) this.results = await Promise.resolve(this.onConfigChanges(changes)).catch(() => changes.map((c) => ({ id: c.id, ok: false, error: 'not applied' })));
      // The gateway judged these on the merged view; this host posts them (its bot, its token).
      const alerts = (Array.isArray(reply.alerts) ? reply.alerts : []).filter((t) => typeof t === 'string' && t).map((t) => t.slice(0, 1000));
      if (alerts.length) Promise.resolve().then(() => this.onAlerts(alerts)).catch((e) => this.log(`dashboard: alert not posted (${e.message})`));
      if (this.lastError) this.log('dashboard: push restored');
      this.lastError = null;
      return true;
    } catch (e) {
      // Never log the URL's query or the token: only the outcome.
      const msg = e.name === 'TimeoutError' ? 'timeout' : e.message;
      if (this.lastError !== msg) this.log(`dashboard: push failed (${msg}); retrying next tick`);
      this.lastError = msg;
      return false;
    } finally { this.inFlight = false; }
  }
}
