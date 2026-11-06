// scripts/bridge/tasks.mjs — what a session is running besides its own turn: shells and subagents,
// each from its start to its end. One board per session, fed by either host adapter (Claude's
// hooks, Codex's app-server items) and read by the dashboard push: how many run now and for how
// long. A live view, not a history: an ended task is listed for ENDED_KEEP_MS, then dropped.

import { TASK_LABEL_MAX, MAX_TASKS } from '../dashboard/public/shared/vocab.mjs';

/** An ended task stays listed this long, so a short one is seen at all. */
export const ENDED_KEEP_MS = 10 * 60000;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// A leading `cd <dir> &&` (or `;`), repeated: where it runs, not what it does.
const LEADING_CD = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/;
// A home directory, as Windows, Git Bash, macOS or Linux spell it: shown as ~.
const HOME = /(?:[A-Za-z]:[\\/]|\/[a-z]\/)Users[\\/][^\\/\s"']+|\/(?:Users|home)\/[^/\s"']+/g;

/** What a task is called: one line, a shell's command without its leading cd and with ~ for home; bounded. */
export function taskLabel(kind, label) {
  const line = oneLine(label);
  return (kind === 'shell' ? line.replace(LEADING_CD, '').replace(HOME, '~') : line).slice(0, TASK_LABEL_MAX);
}

export class TaskBoard {
  constructor() {
    this.tasks = new Map();   // id -> {id, kind, label, background, status, startedAt, endedAt}
  }

  /** A task started. Hooks run async: its end may already be here, and a second start changes nothing. */
  start(id, { kind, label, at, background = false }) {
    const held = this.tasks.get(id);
    if (held?.kind) return;
    // A foreground start stamped before the last turn end arrived late (async hooks): that turn ended it.
    const settled = !background && !held && this.settledAt >= at;
    this.tasks.set(id, { id, kind, label: taskLabel(kind, label), background: !!background, status: held?.status ?? (settled ? 'completed' : 'running'),
      startedAt: at, endedAt: held?.endedAt ?? (settled ? this.settledAt : null) });
  }

  /** A task ended (`status` one of TASK_STATUSES but running). The first end stands. */
  end(id, { status = 'completed', at }) {
    const held = this.tasks.get(id);
    if (held && held.status !== 'running') return;
    // An end before its start (async hooks) is kept, so the late start does not revive it.
    this.tasks.set(id, { ...(held ?? { id, kind: null, label: '', background: false, startedAt: at }), status, endedAt: at });
  }

  /** The background tasks still open are `openIds` (the transcript says so): any other running background task has ended. */
  settleBackground(openIds, at) {
    const open = new Set(openIds);
    for (const t of this.tasks.values()) if (t.background && t.status === 'running' && !open.has(t.id)) this.end(t.id, { status: 'completed', at });
  }

  /**
   * The turn ended: every foreground call of it has returned, so a foreground task still running
   * lost its end (an async hook dropped, a daemon handover) and ends now. Background ones run on.
   */
  settleForeground(at) {
    this.settledAt = Math.max(this.settledAt ?? 0, at);
    for (const t of this.tasks.values()) if (!t.background && t.status === 'running') this.end(t.id, { status: 'completed', at });
  }

  /** The session ended: nothing it started runs on. */
  endAll(status, at) {
    for (const t of this.tasks.values()) if (t.status === 'running') this.end(t.id, { status, at });
  }

  /** Running tasks (oldest first), then those ended within ENDED_KEEP_MS (newest first); bounded. Drops older ones. */
  list(now) {
    for (const [id, t] of this.tasks) if (t.status !== 'running' && now - t.endedAt > ENDED_KEEP_MS) this.tasks.delete(id);
    const known = [...this.tasks.values()].filter((t) => t.kind);
    const running = known.filter((t) => t.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
    const ended = known.filter((t) => t.status !== 'running').sort((a, b) => b.endedAt - a.endedAt);
    return [...running, ...ended].slice(0, MAX_TASKS).map((t) => ({ ...t }));
  }
}
