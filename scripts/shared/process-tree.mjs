// scripts/shared/process-tree.mjs — who is this process's claude? Used by the session-bridge
// channel at its start, to tell a main session from a nested one. No hook reads it: a hook names
// its claude process by the CLAUDE_PID Claude Code gives it.
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

// The one process-table query: PowerShell's CIM on Windows (1.2-3.9 s on a warm workstation, almost
// all of it PowerShell starting, measured 2026-11-17; past 10 s on a fresh CI runner under load),
// ps elsewhere. Each output line is `pid TAB ppid TAB command`. Used only by the session-bridge
// channel at its start (never on a hook), so it may take its time.
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

/**
 * Every process as pid -> {ppid, cmd}: `{ table, error }`. When the OS will not say, the table is
 * empty and `error` names why (timed out, failed, said nothing) -- never an empty table that reads
 * as "no processes". `query` is [command, args], the platform's own by default.
 */
export function readProcessTable({ timeoutMs = 30000, query = TABLE_QUERY } = {}) {
  const [cmd, args] = query;
  let out;
  try {
    out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const why = e.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs} ms`
      : e.code === 'ENOENT' ? 'is not on PATH'
      : `failed (${e.status != null ? `exit ${e.status}` : e.code ?? e.signal}${e.stderr ? `: ${String(e.stderr).trim().split(/\r?\n/)[0]}` : ''})`;
    return { table: new Map(), error: `the process-table query (${cmd}) ${why}` };
  }
  const table = parseTable(out);
  return table.size ? { table, error: null } : { table, error: `the process-table query (${cmd}) listed no process` };
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

