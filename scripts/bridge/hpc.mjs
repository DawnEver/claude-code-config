// scripts/bridge/hpc.mjs — HPC (Slurm) usage for the dashboard's Usage tab (docs/dashboard.md "HPC").
// The dashboard knows no Slurm: a host that declares it runs ONE read door (a command printing a JSON
// report, e.g. dev-lab's `python -m dev_lab.dev.hpcusage report --json`) on a slow cadence — HPC reads
// cost an ssh round per login, so hours, not seconds — and hands the numbers to the usage push.
//
// Off by default. Declared in the machine-LOCAL settings only (`bridge.hpc.command`): it runs a command,
// so the synced file, the dashboard and another host can never make a machine run one; and it needs this
// machine's own cluster logins.
//
// The report (schema 1): {schema, window_hours, grants: [{cluster, account, slurm_account, role, read,
// why? | jobs, core_hours, cpu_efficiency, states{STATE: n}, quota{bytes, files}|null,
// budget{core_hours, spent, committed, since, until, window}|null}]}. Numbers and names of logins only.

import fs from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';

const H = 3600000;
export const HPC_REPORT_SCHEMA = 1;
const DEFAULT_HOURS = 6;
const TIMEOUT_MS = 15 * 60000;
const CHECK_MS = 10 * 60000;

/** `bridge.hpc` of the local layer -> {command, everyMs} | null (off). A malformed block throws its reason. */
export function hpcConfig(raw) {
  if (!raw || raw.command === undefined) return null;
  if (!Array.isArray(raw.command) || !raw.command.length || !raw.command.every((a) => typeof a === 'string' && a))
    throw new Error('bridge.hpc.command must be an argv array of strings, e.g. ["python", "-m", "dev_lab.dev.hpcusage", "report", "--json"]');
  const hours = raw.everyHours ?? DEFAULT_HOURS;
  if (!(typeof hours === 'number' && hours >= 1 && hours <= 168)) throw new Error('bridge.hpc.everyHours must be 1..168');
  return { command: raw.command, everyMs: hours * H };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const COUNTED = { completed: 'COMPLETED', failed: 'FAILED', cancelled: 'CANCELLED', oom: 'OUT_OF_MEMORY', timeout: 'TIMEOUT', running: 'RUNNING' };

/** A report -> store rows (scripts/shared/usage-schema.mjs parseHpc), one per login, keyed by its reading's hour. */
export function hpcRows(report, observedAt) {
  if (report?.schema !== HPC_REPORT_SCHEMA) throw new Error(`HPC report schema ${report?.schema} is not ${HPC_REPORT_SCHEMA}: update this reader with the door`);
  return (Array.isArray(report.grants) ? report.grants : []).map((g) => {
    const read = g.read === true;
    const b = read ? g.budget : null;
    const states = read && g.states && typeof g.states === 'object' ? g.states : {};
    return {
      cluster: g.cluster, account: g.account, hour: Math.floor(observedAt / H) * H, observed_at: observedAt,
      slurm_account: g.slurm_account ?? null, role: g.role || null, read: read ? 1 : 0, why: read ? null : String(g.why ?? 'unknown'),
      jobs: read ? num(g.jobs) : null, core_hours: read ? num(g.core_hours) : null, cpu_efficiency: read ? num(g.cpu_efficiency) : null,
      ...Object.fromEntries(Object.entries(COUNTED).map(([k, s]) => [k, read ? num(states[s]) ?? 0 : null])),
      storage: num(g.quota?.bytes), files: num(g.quota?.files),
      budget_core_hours: num(b?.core_hours), budget_spent: num(b?.spent), budget_committed: num(b?.committed),
      budget_since: b?.since ?? null, budget_until: b?.until ?? null, budget_window: num(b?.window),
    };
  });
}

/**
 * A billed grant's budget run-out, or null: spent plus committed already past its total, or the
 * spend so far, at its average pace, projected past the total before the window ends.
 */
export function budgetAlert(r) {
  const total = r.budget_core_hours, spent = r.budget_spent ?? 0, committed = r.budget_committed ?? 0, window = r.budget_window ?? 0;
  if (!(total > 0)) return null;
  const projected = window > 0 ? Math.round(spent / window) : null;
  if (!(spent + committed >= total || projected > total)) return null;
  return { kind: 'hpc-budget', grant: `${r.cluster}/${r.account}`, spent, committed, total, window, until: r.budget_until, projected };
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function runCommand([cmd, ...args]) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 << 20 },
    (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').at(-1).slice(0, 200))) : resolve(out))));
}

/**
 * Runs the door every `everyMs`, in the background. Its last read time and which budget alerts
 * stand live in `stateFile`, so a daemon hand-over neither reads early nor alerts a standing
 * condition again; `take()` hands the readings to the usage push until they are `stored()`.
 */
export class HpcReader {
  constructor({ command, everyMs, stateFile, raise = () => {}, log = () => {}, run = runCommand, now = Date.now }) {
    Object.assign(this, { command, everyMs, stateFile, raise, log, run, now });
    this.state = { lastAt: 0, alerted: {}, ...readJson(stateFile) };
    this.pending = [];
    this.running = false;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), CHECK_MS);
    this.timer.unref?.();
  }

  #save() { fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); }

  async tick() {
    if (this.running || this.now() - this.state.lastAt < this.everyMs) return;
    this.running = true;
    const at = this.now();
    this.state.lastAt = at;
    try {
      const rows = hpcRows(JSON.parse(await this.run(this.command)), at);
      this.pending.push(...rows);
      this.#alerts(rows);
      this.log(`hpc: read ${rows.filter((r) => r.read).length}/${rows.length} logins`);
    } catch (e) {
      this.log(`hpc: read failed (${e.message}); next in ${Math.round(this.everyMs / H)} h`);
    } finally {
      this.#save();
      this.running = false;
    }
  }

  // Once per condition: raised when a grant goes over, forgotten when it recovers.
  #alerts(rows) {
    for (const r of rows.filter((x) => x.read)) {
      const key = `${r.cluster}/${r.account}`;
      const alert = budgetAlert(r);
      if (!alert) { delete this.state.alerted[key]; continue; }
      if (this.state.alerted[key]) continue;
      this.state.alerted[key] = r.observed_at;
      this.raise({ id: `hpc-${createHash('sha256').update(`${key}|${r.observed_at}`).digest('hex').slice(0, 12)}`, ...alert });
    }
  }

  /** The readings not yet stored, or null; `stored()` once the store accepted them. */
  take() {
    if (!this.pending.length) return null;
    const rows = this.pending;
    return { rows, stored: () => { this.pending = this.pending.filter((r) => !rows.includes(r)); } };
  }
}
