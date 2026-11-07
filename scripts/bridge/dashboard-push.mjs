// scripts/bridge/dashboard-push.mjs — pushes this machine's session snapshot to the dashboard
// (docs/dashboard.md). Outbound HTTPS only: the gateway never reaches this machine, and
// the bridge's IPC stays on 127.0.0.1. Fire-and-forget: a push overlapping the previous one
// is skipped, every failure is logged once, nothing is retried, nothing is awaited by the
// Telegram path. `bootAt` (this daemon's start) + `seq` let the gateway drop a delayed push
// from an older daemon or an earlier tick: both are this host's own clock and counter.
// A tick whose snapshot is unchanged since the last accepted push is skipped, except once per
// `heartbeatSeconds`: that keeps the host online for the gateway (and refreshes the machine load,
// which changes every tick and so is left out of the comparison) at a fraction of the requests.

import { randomUUID } from 'crypto';
import { SCHEMA_VERSION } from '../shared/dashboard-schema.mjs';

/** Alerts held for the gateway at most; the gateway reads as many per push. */
export const MAX_ALERTS = 20;

export class DashboardPush {
  constructor({ url, hostToken, machine, sessions, accounts = () => [], forges = null, resources = () => null, config = () => null, onConfigChanges = () => [], everySeconds = 15, heartbeatSeconds = 60, log = () => {}, fetch = globalThis.fetch, timeoutMs = 5000, now = Date.now }) {
    Object.assign(this, { url: `${url}/api/hosts/${machine}/snapshot`, hostToken, sessions, accounts, forges, resources, config, onConfigChanges, everySeconds, heartbeatSeconds, log, fetch, timeoutMs, now });
    this.sentKey = null;   // the last accepted snapshot minus seq and machine load
    this.sentAt = 0;
    this.bootAt = now();
    this.seq = 0;
    this.inFlight = false;
    this.lastError = null;
    this.results = [];   // outcomes of config changes applied here, reported on the next push
    this.alerts = [];    // alerts raised here (a failed turn), sent on every push until one is accepted
  }

  /** An alert for the human, sent by the gateway as the dashboard bot (registry.mjs). Bounded: the newest MAX_ALERTS. */
  raise(alert) {
    this.alerts = [...this.alerts, { id: randomUUID(), ...alert }].slice(-MAX_ALERTS);
  }

  body() {
    // Accounts first: a session is labelled with the account it spends (sessions(accounts)).
    const accounts = this.accounts();
    // The forge sources this host could read and the readings it owes (forges.mjs ForgeReader):
    // the gateway answers which to read next, so a source is read by one host per interval.
    this.sending = this.forges ? this.forges.outbox() : [];
    return { schemaVersion: SCHEMA_VERSION, bootAt: this.bootAt, seq: 0, sessions: this.sessions(accounts), accounts,
      ...(this.forges ? { forges: { sources: this.forges.ids(), readings: this.sending } } : {}), resources: this.resources(), config: this.config(), configResults: this.results,
      alerts: (this.alertsSending = this.alerts) };
  }

  /** Off the message path: an unref'd timer, never awaited by Telegram routing. */
  start() {
    this.timer = setInterval(() => this.tick(), this.everySeconds * 1000);
    this.timer.unref?.();
    return this.timer;
  }

  async tick() {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const body = this.body();
      const key = JSON.stringify({ ...body, seq: 0, resources: null });
      if (key === this.sentKey && this.now() - this.sentAt < this.heartbeatSeconds * 1000) return 'unchanged';
      body.seq = ++this.seq;
      const res = await this.fetch(this.url, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.hostToken}` }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refused: the gateway holds a push it ranks newer (this host's clock went backwards or ahead).
      const reply = await res.json().catch(() => ({}));
      if (reply.accepted !== true) throw new Error('refused as not newer than the one held');
      this.results = [];   // delivered with this push
      this.sentKey = key;
      this.sentAt = this.now();
      this.alerts = this.alerts.filter((a) => !this.alertsSending.includes(a));
      if (this.forges) {
        this.forges.delivered(this.sending);
        this.forges.assign((Array.isArray(reply.forgeRead) ? reply.forgeRead : []).filter((id) => typeof id === 'string'));
      }
      // Changes the gateway hands this host: applied (and validated again) by the daemon.
      const changes = (Array.isArray(reply.configChanges) ? reply.configChanges : []).filter((c) => typeof c?.id === 'string');
      if (changes.length) this.results = await Promise.resolve(this.onConfigChanges(changes)).catch(() => changes.map((c) => ({ id: c.id, ok: false, error: 'not applied' })));
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
