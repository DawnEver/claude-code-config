// scripts/bridge/resources.mjs — this machine's load and hardware for the dashboard's host
// header. Numbers and hardware model names only: no process names, no paths.
//
// Load (sampled on every push): CPU is the busy share of every core since the previous
// sample. Memory is what is not available: os.freemem() on Windows and Linux (libuv reads
// MemAvailable there), but on macOS it counts only never-used pages, so there `vm_stat` adds
// back the inactive and purgeable ones. GPUs come from `nvidia-smi` where it exists.
// Hardware (read once): the CPU model from Node; the memory type (DDR4, DDR5, LPDDR5...) from
// the OS — Win32_PhysicalMemory, system_profiler, or dmidecode (Linux, usually root only:
// unknown otherwise). A probe a host lacks is never run again.

import os from 'os';
import { execFile } from 'child_process';

const GPU_QUERY = ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
// SMBIOS memory type codes (DMTF DSP0134, table "Memory Device — Type").
const SMBIOS_MEMORY = { 18: 'DDR', 19: 'DDR2', 24: 'DDR3', 26: 'DDR4', 27: 'LPDDR', 28: 'LPDDR2', 29: 'LPDDR3', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5' };
const MEMORY_TYPE = /\b(LP)?DDR\d?X?\b/;
// How each OS names its memory type: the command, and its output -> the type or null.
const MEMORY_PROBES = {
  win32: ['powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_PhysicalMemory).SMBIOSMemoryType'],
    (out) => String(out).split(/\r?\n/).map((l) => SMBIOS_MEMORY[l.trim()]).find(Boolean) ?? null],
  darwin: ['system_profiler', ['SPMemoryDataType'], (out) => memoryTypeIn(/^\s*Type:\s*(.+)$/m.exec(String(out))?.[1])],
  linux: ['dmidecode', ['-t', '17'], (out) => memoryTypeIn(String(out).split('\n').find((l) => /^\s*Type:\s*\S*DDR/.test(l)))],
};

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

/** A memory type named in free text (`Type: LPDDR5`, `DDR4`), or null. */
export const memoryTypeIn = (text) => MEMORY_TYPE.exec(String(text ?? ''))?.[0] ?? null;

/** A CPU model as people say it: no (R)/(TM) marks, "CPU", "@ 2.40GHz" or "16-Core Processor" (cores are shown apart). */
export const cpuModelName = (model) => String(model ?? '').replace(/\((?:R|TM)\)/gi, '').replace(/\s+@.*$/, '')
  .replace(/\s+\d+-Core Processor$/i, '').replace(/\bCPU\b/g, '').replace(/\s+/g, ' ').trim() || null;

/** Each OS's memory-type probe as [command, args, parse], or null where none exists. */
export const memoryProbe = (platform) => MEMORY_PROBES[platform] ?? null;

const cpuTimes = () => os.cpus().reduce((t, c) => {
  const all = Object.values(c.times).reduce((a, b) => a + b, 0);
  return { busy: t.busy + all - c.times.idle, all: t.all + all };
}, { busy: 0, all: 0 });

export class ResourceReader {
  constructor({ exec = execFile, timeoutMs = 10000, platform = process.platform } = {}) {
    Object.assign(this, { exec, timeoutMs });
    this.prev = cpuTimes();
    this.gpus = [];
    this.available = null;   // macOS: from vm_stat
    this.memType = null;
    this.cpuModel = cpuModelName(os.cpus()[0]?.model);
    // Each probe: its command, what to do with its output, and whether one answer is enough.
    this.probes = new Map([['nvidia-smi', { args: GPU_QUERY, take: (out) => { this.gpus = out === null ? [] : parseNvidiaSmi(out); } }]]);
    if (platform === 'darwin') this.probes.set('vm_stat', { args: [], take: (out) => { this.available = out === null ? null : parseVmStat(out); } });
    const mem = memoryProbe(platform);
    if (mem) this.probes.set(mem[0], { args: mem[1], once: true, take: (out) => { this.memType = out === null ? null : mem[2](out); } });
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
    return { cpu, cores: os.cpus().length, cpuModel: this.cpuModel,
      mem: { used: Math.max(0, total - free), total, type: this.memType }, gpus: this.gpus };
  }

  #probe(cmd, probe) {
    if (probe.running) return;
    probe.running = true;
    this.exec(cmd, probe.args, { timeout: this.timeoutMs, windowsHide: true }, (err, out) => {
      probe.running = false;
      // Missing, or a fixed fact already read (or not readable here: no root for dmidecode): never again.
      if (err?.code === 'ENOENT' || probe.once) this.probes.delete(cmd);
      probe.take(err ? null : out);
    });
  }
}
