// scripts/bridge/resources.mjs — this machine's CPU, memory and GPU load for the dashboard's
// Quota tab (shown only when a viewer turns it on). Numbers only: no process names, no paths.
// CPU is the busy share of every core since the previous sample. Memory is what is not
// available: os.freemem() on Windows and Linux (libuv reads MemAvailable there), but on macOS
// it counts only never-used pages, so there `vm_stat` adds back the inactive and purgeable
// ones. GPUs come from `nvidia-smi` where it exists. A probe a host lacks is never run again.

import os from 'os';
import { execFile } from 'child_process';

const GPU_QUERY = ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];

/** `nvidia-smi` CSV -> [{name, util, memUsed, memTotal}] (memory in bytes). */
export function parseNvidiaSmi(out) {
  return String(out).split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim())).filter((f) => f.length === 4 && f[0])
    .map(([name, util, used, total]) => ({ name, util: Number(util), memUsed: Number(used) * 1048576, memTotal: Number(total) * 1048576 }))
    .filter((g) => [g.util, g.memUsed, g.memTotal].every(Number.isFinite));
}

/** macOS `vm_stat` -> available bytes (free + inactive + speculative + purgeable pages), or null. */
export function parseVmStat(out) {
  const text = String(out);
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return page > 0 ? page * (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) : null;
}

const cpuTimes = () => os.cpus().reduce((t, c) => {
  const all = Object.values(c.times).reduce((a, b) => a + b, 0);
  return { busy: t.busy + all - c.times.idle, all: t.all + all };
}, { busy: 0, all: 0 });

export class ResourceReader {
  constructor({ exec = execFile, timeoutMs = 3000, platform = process.platform } = {}) {
    Object.assign(this, { exec, timeoutMs });
    this.prev = cpuTimes();
    this.gpus = [];
    this.available = null;   // macOS: from vm_stat
    // Each probe: its command, and what to do with its output. Run one at a time, never awaited.
    this.probes = new Map([['nvidia-smi', { args: GPU_QUERY, take: (out) => { this.gpus = out === null ? [] : parseNvidiaSmi(out); } }]]);
    if (platform === 'darwin') this.probes.set('vm_stat', { args: [], take: (out) => { this.available = out === null ? null : parseVmStat(out); } });
  }

  /** The current sample; the probes are started for the next one (never awaited by the push). */
  read() {
    const now = cpuTimes();
    const all = now.all - this.prev.all;
    const cpu = all > 0 ? Math.round(((now.busy - this.prev.busy) / all) * 100) : null;
    this.prev = now;
    for (const [cmd, probe] of this.probes) this.#probe(cmd, probe);
    const total = os.totalmem();
    const free = this.available ?? os.freemem();
    return { cpu, cores: os.cpus().length, mem: { used: Math.max(0, total - free), total }, gpus: this.gpus };
  }

  #probe(cmd, probe) {
    if (probe.running) return;
    probe.running = true;
    this.exec(cmd, probe.args, { timeout: this.timeoutMs, windowsHide: true }, (err, out) => {
      probe.running = false;
      if (err?.code === 'ENOENT') this.probes.delete(cmd);
      probe.take(err ? null : out);
    });
  }
}
