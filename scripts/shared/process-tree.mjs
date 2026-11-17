// scripts/shared/process-tree.mjs — who is this process's claude? Used by the session-bridge
// channel (main vs nested session) and bridge-hook.js (routing after /clear or /resume).
import { execFileSync, spawn } from 'child_process';

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

// The one process-table query: PowerShell's CIM on Windows (1.2-3.9 s, almost all of it PowerShell
// starting, measured 2026-11-17), ps elsewhere. Each output line is `pid TAB ppid TAB command`.
const TABLE_QUERY = process.platform === 'win32'
  ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })" }']]
  : ['ps', ['-A', '-o', 'pid=,ppid=,args=']];

/** The query's output as pid -> {ppid, cmd}; ps pads its columns with spaces, PowerShell's are tab-separated. */
export function parseTable(out, { ps = TABLE_QUERY[0] === 'ps' } = {}) {
  const table = new Map();
  const text = ps ? String(out).replace(/^[ \t]*(\d+)[ \t]+(\d+)[ \t]+/gm, '$1\t$2\t') : String(out);
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, ...cmd] = line.split('\t');
    if (pid && ppid) table.set(Number(pid), { ppid: Number(ppid), cmd: cmd.join('\t') });
  }
  return table;
}

/** pid -> {ppid, cmd} for every process; empty when the OS will not say. */
export function processTable({ timeoutMs = 10000 } = {}) {
  try {
    return parseTable(execFileSync(TABLE_QUERY[0], TABLE_QUERY[1], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return new Map(); /* unknown ancestry: only the CLAUDE_PID rule applies */ }
}

/**
 * The same table, without blocking: `onSnapshot` fires when the first line arrives -- the OS has
 * taken its snapshot by then, so a process that exits afterwards is still in the table.
 */
export function processTableAsync({ timeoutMs = 10000, onSnapshot = () => {}, query = TABLE_QUERY } = {}) {
  return new Promise((resolve) => {
    let out = '', snapped = false;
    let child;
    try { child = spawn(query[0], query[1], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(new Map()); return; }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; if (!snapped) { snapped = true; onSnapshot(); } });
    child.on('error', () => { clearTimeout(timer); resolve(new Map()); });
    child.on('close', () => { clearTimeout(timer); resolve(parseTable(out)); });
  });
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
