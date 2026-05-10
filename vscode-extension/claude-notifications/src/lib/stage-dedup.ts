import * as fs from 'fs';
import { getStateDir, getSessionsPath } from './state-paths';

const SESSIONS_PRUNE_MS = 60 * 60 * 1000; // 1h

interface SessionEntry {
  stageId: number;
  lastEvent: string | null;
  resolved: boolean;
  lastNotifiedAt: number;
  updatedAt: number;
}

interface SessionsMap {
  [sessionId: string]: SessionEntry;
}

function ensureDir(workspaceRoot: string): string {
  const dir = getStateDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readSessions(workspaceRoot: string): SessionsMap {
  const p = getSessionsPath(workspaceRoot);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeSessions(workspaceRoot: string, map: SessionsMap): void {
  ensureDir(workspaceRoot);
  const now = Date.now();
  for (const key of Object.keys(map)) {
    const u = map[key]?.updatedAt;
    if (typeof u === 'number' && now - u > SESSIONS_PRUNE_MS) {
      delete map[key];
    }
  }
  try {
    fs.writeFileSync(getSessionsPath(workspaceRoot), JSON.stringify(map));
  } catch {
    /* silent */
  }
}

export function shouldNotify(
  workspaceRoot: string,
  sessionId: string,
  currentEvent: string,
): { notify: boolean; stageId: number | null } {
  if (!sessionId) return { notify: true, stageId: null };

  const map = readSessions(workspaceRoot);
  const now = Date.now();
  let entry = map[sessionId];

  if (!entry) {
    entry = { stageId: 1, lastEvent: currentEvent, resolved: false, lastNotifiedAt: now, updatedAt: now };
    map[sessionId] = entry;
    writeSessions(workspaceRoot, map);
    return { notify: true, stageId: 1 };
  }

  // Fresh stage from UserPromptSubmit
  if (entry.lastEvent === null) {
    entry.lastEvent = currentEvent;
    entry.resolved = false;
    entry.lastNotifiedAt = now;
    entry.updatedAt = now;
    writeSessions(workspaceRoot, map);
    return { notify: true, stageId: entry.stageId };
  }

  if (entry.resolved === true) {
    entry.stageId = (entry.stageId || 0) + 1;
    entry.lastEvent = currentEvent;
    entry.resolved = false;
    entry.lastNotifiedAt = now;
    entry.updatedAt = now;
    writeSessions(workspaceRoot, map);
    return { notify: true, stageId: entry.stageId };
  }

  // Unresolved stage — suppress re-fire
  entry.lastEvent = currentEvent;
  entry.updatedAt = now;
  writeSessions(workspaceRoot, map);
  return { notify: false, stageId: entry.stageId };
}

export function advanceOnPrompt(workspaceRoot: string, sessionId: string): void {
  if (!sessionId) return;
  const map = readSessions(workspaceRoot);
  const now = Date.now();
  const entry = map[sessionId] || {
    stageId: 0,
    lastEvent: null,
    resolved: false,
    lastNotifiedAt: 0,
    updatedAt: now,
  };
  entry.stageId = (entry.stageId || 0) + 1;
  entry.lastEvent = null;
  entry.resolved = false;
  entry.updatedAt = now;
  map[sessionId] = entry;
  writeSessions(workspaceRoot, map);
}

export function markResolved(workspaceRoot: string, sessionId: string): void {
  if (!sessionId) return;
  const map = readSessions(workspaceRoot);
  const entry = map[sessionId];
  if (!entry) return;
  entry.resolved = true;
  entry.updatedAt = Date.now();
  writeSessions(workspaceRoot, map);
}
