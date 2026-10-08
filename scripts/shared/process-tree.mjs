// scripts/shared/process-tree.mjs — who is this process's claude? Used by the session-bridge
// channel (main vs nested session) and bridge-hook.js (routing after /clear or /resume).
import { execFileSync } from 'child_process';

/** The first `n` tokens of a command line, honouring double quotes. */
export function tokens(cmd, n) {
  return [...String(cmd).matchAll(/"([^"]*)"|(\S+)/g)].slice(0, n).map((m) => m[1] ?? m[2]);
}

export const base = (p) => String(p ?? '').split(/[\\/]/).pop().toLowerCase();

// Claude's own background-session hosts (`claude daemon run` -> `claude --bg-pty-host ... --
// claude --resume ...`) run the CLI binary but are not a session around the one they host.
const HOST_MODES = new Set(['daemon', '--bg-pty-host']);

/** Is this command line a claude CLI session (not a shim, launcher, shell or background host)? */
export function isClaudeProcess(cmd) {
  const [prog, a, b] = tokens(cmd, 3);
  if (/^claude(\.exe)?$/.test(base(prog))) return !HOST_MODES.has(a);
  return /^node(\.exe)?$/.test(base(prog)) && /@anthropic-ai[\\/]claude-code[\\/]/i.test(a ?? '') && !HOST_MODES.has(b);
}

/** pid -> {ppid, cmd} for every process; empty when the OS will not say. */
export function processTable({ timeoutMs = 10000 } = {}) {
  const table = new Map();
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })" }'],
        { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
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
