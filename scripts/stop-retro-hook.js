#!/usr/bin/env node
// stop-retro-hook.js — Claude Code Stop hook script
// Prevents session stop (exit 2) to trigger a session retrospective
// when enough work has been done. State tracked in .claude/.retro_state.json

import fs from 'node:fs';
import path from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateFile = path.join(projectDir, '.claude', '.retro_state.json');

// Thresholds
const MIN_STOP_COUNT = 3;
const MIN_SESSION_MS = 2 * 60 * 1000; // 2 minutes

// ── Helpers ──

function readStdinJSON() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function log(msg) {
  process.stderr.write(`[retro-hook] ${msg}\n`);
}

function loadState() {
  try {
    let raw = fs.readFileSync(stateFile, 'utf8');
    // Strip UTF-8 BOM if present (e.g. from PowerShell editors)
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

// ── Main ──

const input = readStdinJSON();
const now = Date.now();
let state = loadState();

// Fresh session detection: no state, different session, or stale (>30 min idle)
const isFresh = !state
  || (state.sessionId && input.session_id && state.sessionId !== input.session_id)
  || (now - (state.lastTouched || 0) > 30 * 60 * 1000);

if (isFresh) {
  state = {
    sessionId: input.session_id || `sess-${now}`,
    stopCount: 0,
    firstStopAt: null,
    retroPending: false,
    retroDone: false,
    lastTouched: now,
  };
}

// Update counters
state.stopCount = (state.stopCount || 0) + 1;
if (!state.firstStopAt) state.firstStopAt = now;
state.lastTouched = now;

const retroDone = state.retroDone;
const retroPending = state.retroPending;
const sessionAge = now - (state.firstStopAt || now);
const stopCount = state.stopCount;

let decision = 'allow';

if (retroDone) {
  // Retro already completed this session — allow stop
  decision = 'allow';
} else if (retroPending) {
  // We triggered retro last turn; this turn it should be done
  state.retroDone = true;
  state.retroPending = false;
  decision = 'allow';
  log('retro completed — allowing stop');
} else if (stopCount >= MIN_STOP_COUNT && sessionAge >= MIN_SESSION_MS) {
  // Conditions met — trigger retro
  state.retroPending = true;
  decision = 'deny';
  log(`retro trigger: stop #${stopCount}, session ~${Math.round(sessionAge / 60000)}min — blocking stop for retrospective`);
}

saveState(state);

if (decision === 'deny') {
  process.exit(2);
} else {
  process.exit(0);
}
