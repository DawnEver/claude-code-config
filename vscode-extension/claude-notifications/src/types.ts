/**
 * A notification event from Claude Code hooks
 */
export type ClaudeEvent = {
  ts?: string;
  event?: string;
  severity?: string;
  title?: string;
  message?: string;
  cwd?: string;
  folder?: string;
  workspace?: string;
  goto?: string | null;
  ppid?: number;
};

/**
 * Compute a stable dedup key (content-only, no timestamp) for burst suppression
 */
export function dedupKey(e: Pick<ClaudeEvent, 'event' | 'folder' | 'title' | 'message'>): string {
  return `${e.event ?? ''}|${e.folder ?? e.title ?? ''}|${e.message ?? ''}`;
}

/**
 * Resolve ${userHome} placeholder in paths
 */
export function resolveHome(p: string): string {
  return p.includes('${userHome}') ? p.replace('${userHome}', require('os').homedir()) : p;
}

/**
 * Format an event for display in the output channel
 */
export function formatLine(e: ClaudeEvent): string {
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
  const ev = e.event ?? 'Event';
  const sev = e.severity ? ` ${e.severity.toUpperCase()}` : '';
  const msg = e.message ?? '';
  const cwd = e.cwd ?? e.workspace ?? '';
  const tail = cwd ? ` (${cwd})` : '';
  return `[${ts}] [${ev}${sev}] ${msg}${tail}`;
}
