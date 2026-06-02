#!/usr/bin/env node
// stop-retro-hook.js — Claude Code Stop hook
// Tracks session state; after 3+ stops & 2+ min, injects /retrospect skill.
// State tracked in .claude/.retro_state.json

import fs from 'node:fs';
import path from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateFile = path.join(projectDir, '.claude', '.retro_state.json');

const MIN_STOP_COUNT = 3;
const MIN_SESSION_MS = 2 * 60 * 1000;

function readStdinJSON() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadState() {
  try {
    let raw = fs.readFileSync(stateFile, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

const input = readStdinJSON();
const now = Date.now();
let state = loadState();

const inputKey = input.session_id ?? null;
const storedKey = state?.sessionKey ?? state?.sessionId ?? null;

const knownSessionChange = inputKey != null && storedKey != null && storedKey !== inputKey;

const isFresh = !state
  || knownSessionChange
  || (now - (state.lastTouched || 0) > 30 * 60 * 1000);

const sessionKey = inputKey ?? (isFresh ? null : storedKey);

if (isFresh) {
  state = {
    sessionKey,
    stopCount: 0,
    firstStopAt: null,
    retroPending: false,
    retroDone: false,
    lastTouched: now,
    taskActiveUntil: null,
  };
}

const backgroundTasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
const taskActiveUntil = Number.isFinite(state.taskActiveUntil) ? state.taskActiveUntil : 0;
const hasPendingWork = backgroundTasks.length > 0 || now < taskActiveUntil;

if (!hasPendingWork) {
  state.stopCount = (state.stopCount || 0) + 1;
  if (!state.firstStopAt) state.firstStopAt = now;
}
state.lastTouched = now;

const sessionAge = now - (state.firstStopAt || now);
const stopCount = state.stopCount;

let decision = 'allow';

if (state.retroDone) {
  decision = 'allow';
} else if (hasPendingWork) {
  decision = 'allow';
} else if (state.retroPending) {
  state.retroDone = true;
  state.retroPending = false;
  decision = 'allow';
} else if (stopCount >= MIN_STOP_COUNT && sessionAge >= MIN_SESSION_MS) {
  state.retroPending = true;
  decision = 'deny';
}

saveState(state);

if (decision === 'deny') {
  process.stderr.write('/retrospect\n', () => process.exit(2));
} else {
  process.exit(0);
}
