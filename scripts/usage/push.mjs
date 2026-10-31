// scripts/usage/push.mjs — sends this machine's usage to the dashboard's store (docs/usage.md):
// new turns and session costs (from the transcripts, via UsageScanner), each quota window's
// use, and the machine's load per hour. Outbound HTTPS with the host's dashboard token, off
// the Telegram path. Nothing is lost on a failure: the cursor moves only once the store has
// accepted a batch, and the next tick sends it again (the store upserts by key).

import { USAGE_SCHEMA_VERSION, MAX_USAGE_ROWS } from '../shared/usage-schema.mjs';

const H = 3600000;
// A window's opening, rounded: two readings of one window disagree on its reset by a little.
const ROUND = 10 * 60000;

/** The hour sums of a stream of resource samples (scripts/bridge/resources.mjs read()). */
export class HourlyResources {
  constructor() { this.cur = null; this.done = []; }

  add(r, now) {
    if (!r || !(r.mem?.total > 0)) return;
    const hour = Math.floor(now / H) * H;
    if (this.cur && this.cur.hour !== hour) { this.done.push(this.cur); this.cur = null; }
    const gpu = r.gpus?.length ? Math.max(...r.gpus.map((g) => g.util ?? 0)) : null;
    const gpuMem = r.gpus?.length ? Math.max(...r.gpus.map((g) => g.memUsed ?? 0)) : null;
    const c = this.cur ??= { hour, samples: 0, cpu_sum: 0, cpu_max: 0, mem_sum: 0, mem_max: 0, mem_total: 0, gpu_sum: null, gpu_max: null, gpu_mem_max: null };
    const cpu = r.cpu ?? 0;
    c.samples++;
    c.cpu_sum += cpu; c.cpu_max = Math.max(c.cpu_max, cpu);
    c.mem_sum += r.mem.used; c.mem_max = Math.max(c.mem_max, r.mem.used); c.mem_total = r.mem.total;
    if (gpu !== null) {
      c.gpu_sum = (c.gpu_sum ?? 0) + gpu; c.gpu_max = Math.max(c.gpu_max ?? 0, gpu); c.gpu_mem_max = Math.max(c.gpu_mem_max ?? 0, gpuMem);
    }
  }

  /** Completed hours, handed over once. A partial hour stays until it completes. */
  take() { const d = this.done; this.done = []; return d; }
}

/** Every current quota window of `accounts` (scripts/bridge/quota.mjs accountModels) as a store row. */
export function quotaRows(accounts, now) {
  return (accounts ?? []).flatMap((a) => (a.windows ?? []).filter((w) => w.resetsAt > now && a.at).map((w) => ({
    account: a.key, agent: a.agent, span: w.k, window_start: Math.round((w.resetsAt - w.windowMs) / ROUND) * ROUND,
    window_ms: w.windowMs, used: w.used, observed_at: a.at })));
}

export class UsagePush {
  constructor({ url, hostToken, machine, scanner, accounts = () => [], history = () => null, everyMs = 5 * 60000, log = () => {}, fetch = globalThis.fetch, timeoutMs = 30000, now = Date.now }) {
    // `history`: the forges' commits and pull requests to store (forges.mjs ForgeReader takeHistory).
    Object.assign(this, { url: `${url}/api/hosts/${machine}/usage`, hostToken, scanner, accounts, history, everyMs, log, fetch, timeoutMs, now });
    this.hourly = new HourlyResources();
    this.resources = [];
    this.running = false;
    this.lastError = null;
  }

  /** Feed one resource sample (the dashboard push reads one every few seconds). */
  sample(r) { this.hourly.add(r, this.now()); }

  /** First round after a minute: the Codex account (part of each Codex row's key) is known by then. */
  start() {
    setTimeout(() => this.tick(), 60000).unref?.();
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  async post(body) {
    const res = await this.fetch(this.url, { method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.hostToken}` },
      body: JSON.stringify({ schemaVersion: USAGE_SCHEMA_VERSION, ...body }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /** One round: everything new, in batches; a backlog (the first run) drains round after round. */
  async tick() {
    if (this.running) return false;
    this.running = true;
    try {
      this.resources.push(...this.hourly.take());
      // Quota and finished hours first, on their own: once accepted they are never sent again
      // (an hour's sums would double).
      const quota = quotaRows(this.accounts(), this.now());
      if (quota.length || this.resources.length) {
        await this.post({ turns: [], costs: [], quota, resources: this.resources });
        this.resources = [];
      }
      for (;;) {
        const batch = await this.scanner.collect();
        for (const kind of ['turns', 'costs']) {
          for (let i = 0; i < batch[kind].length; i += MAX_USAGE_ROWS) {
            await this.post({ turns: [], costs: [], quota: [], resources: [], [kind]: batch[kind].slice(i, i + MAX_USAGE_ROWS) });
          }
        }
        batch.commit();
        if (!batch.more) break;
        this.log(`usage: backfill sent ${batch.turns.length} turns, continuing`);
      }
      // The forges' history, in batches; its cursor moves only once every batch is stored.
      const history = this.history();
      if (history) {
        for (const kind of ['commits', 'pulls']) {
          for (let i = 0; i < history[kind].length; i += MAX_USAGE_ROWS) {
            await this.post({ turns: [], costs: [], quota: [], resources: [], [kind]: history[kind].slice(i, i + MAX_USAGE_ROWS) });
          }
        }
        history.stored();
      }
      if (this.lastError) this.log('usage: push restored');
      this.lastError = null;
      return true;
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'timeout' : e.message;
      if (this.lastError !== msg) this.log(`usage: push failed (${msg}); retrying in ${Math.round(this.everyMs / 60000)} min`);
      this.lastError = msg;
      return false;
    } finally { this.running = false; }
  }
}
