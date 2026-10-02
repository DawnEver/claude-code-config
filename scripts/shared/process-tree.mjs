// scripts/shared/process-tree.mjs — who is this process's claude? Used by the session-bridge
// channel (main vs nested session) and bridge-hook.js (routing after /clear).
import { execFileSync } from 'child_process';

/** The first `n` tokens of a command line, honouring double quotes. */
export function tokens(cmd, n) {
  return [...String(cmd).matchAll(/"([^"]*)"|(\S+)/g)].slice(0, n).map((m) => m[1] ?? m[2]);
}

export const base = (p) => String(p ?? '').split(/[\\/]/).pop().toLowerCase();

/** Is this command line the claude CLI itself (not a shim, launcher or shell that names it)? */
export function isClaudeProcess(cmd) {
  const [prog, script] = tokens(cmd, 2);
  if (/^claude(\.exe)?$/.test(base(prog))) return true;
  return /^node(\.exe)?$/.test(base(prog)) && /@anthropic-ai[\\/]claude-code[\\/]/i.test(script ?? '');
}

/** pid -> {ppid, cmd} for every process; empty when the OS will not say. */
export function processTable() {
  const table = new Map();
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })" }'],
        { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        .replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1\t$2\t');
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, ...cmd] = line.split('\t');
      if (pid && ppid) table.set(Number(pid), { ppid: Number(ppid), cmd: cmd.join('\t') });
    }
  } catch { /* unknown ancestry: only the CLAUDE_PID rule applies */ }
  return table;
}

/** [{pid, cmd}] from `pid` upward. */
export function ancestorsOf(pid, table, max = 64) {
  const out = [];
  while (table.has(pid) && out.length < max && !out.some((a) => a.pid === pid)) {
    const p = table.get(pid);
    out.push({ pid, cmd: p.cmd });
    pid = p.ppid;
  }
  return out;
}

/** The nearest claude CLI at or above `pid`, or null. */
export function nearestClaude(pid, table = processTable()) {
  return ancestorsOf(pid, table).find((a) => isClaudeProcess(a.cmd))?.pid ?? null;
}
