#!/usr/bin/env node
// stop-retro-hook.js — Claude Code Stop hook script
// Prevents session stop (exit 2) to trigger a session retrospective
// when enough work has been done. State tracked in .claude/.retro_state.json

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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

const CODE_EXTENSIONS = /\.(py|rs|js|ts|jsx|tsx|java|go|cpp|c|h|cs|rb|sh|toml|yaml|yml|json)$/i;
const DOC_ONLY_PATTERNS = [/\.md$/i, /^memories\//, /^\.claude\//, /^MEMORY\.md$/i, /^README/i];

function getChangedFiles() {
  try {
    const out = execSync('git status --porcelain', { cwd: projectDir, timeout: 5000 }).toString();
    return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}

function detectSimpleTask(stopCount, sessionAge) {
  if (stopCount > 4 || sessionAge > 10 * 60 * 1000) return false;

  const files = getChangedFiles();
  if (files.length === 0) return true;

  const isDocOnly = files.every(f => DOC_ONLY_PATTERNS.some(p => p.test(f)));
  const hasCode = files.some(f => CODE_EXTENSIONS.test(f));

  return isDocOnly || !hasCode;
}

const input = readStdinJSON();
const now = Date.now();
let state = loadState();

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

state.stopCount = (state.stopCount || 0) + 1;
if (!state.firstStopAt) state.firstStopAt = now;
state.lastTouched = now;

const retroDone = state.retroDone;
const retroPending = state.retroPending;
const sessionAge = now - (state.firstStopAt || now);
const stopCount = state.stopCount;

let decision = 'allow';

if (retroDone) {
  decision = 'allow';
} else if (retroPending) {
  state.retroDone = true;
  state.retroPending = false;
  decision = 'allow';
} else if (stopCount >= MIN_STOP_COUNT && sessionAge >= MIN_SESSION_MS) {
  state.retroPending = true;
  decision = 'deny';
}

saveState(state);

if (decision === 'deny') {
  const isSimple = detectSimpleTask(stopCount, sessionAge);

  const baseMsg = `Please run a session retrospective before stopping (stop #${stopCount}, session ~${Math.round(sessionAge / 60000)}min).`;
  const fullMsg = isSimple
    ? `${baseMsg} This appears to be a lightweight session — summarize what was done briefly. No need to update README or memory files.`
    : `${baseMsg} Include: what changed, how it was validated, and any open blockers. Update README/memory as appropriate.`;

  process.stderr.write(fullMsg + '\n', () => process.exit(2));
} else {
  process.exit(0);
}
