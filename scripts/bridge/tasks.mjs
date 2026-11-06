// scripts/bridge/tasks.mjs — what a session is running besides its own turn: shells and subagents,
// each from its start to its end. One board per session, fed by either host adapter (Claude's
// hooks, Codex's app-server items) and read by the dashboard push: how many run now and for how
// long. A live view, not a history: an ended task is listed for ENDED_KEEP_MS, then dropped.

import { TASK_LABEL_MAX, MAX_TASKS } from '../dashboard/public/shared/vocab.mjs';

/** An ended task stays listed this long, so a short one is seen at all. */
export const ENDED_KEEP_MS = 10 * 60000;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, TASK_LABEL_MAX);

export class TaskBoard {
  constructor() {
    this.tasks = new Map();   // id -> {id, kind, label, background, status, startedAt, endedAt}
  }

  /** A task started. Hooks run async: its end may already be here, and a second start changes nothing. */
  start(id, { kind, label, at, background = false }) {
    const held = this.tasks.get(id);
    if (held?.kind) return;
    this.tasks.set(id, { id, kind, label: oneLine(label), background: !!background, status: held?.status ?? 'running',
      startedAt: at, endedAt: held?.endedAt ?? null });
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
