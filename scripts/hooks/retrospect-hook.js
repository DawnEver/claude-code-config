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

const COMPACT_THRESHOLD = 20;

function countMemoryEntries() {
  try {
    const indexPath = path.join(projectDir, '.claude', 'rules', 'MEMORY.md');
    const content = fs.readFileSync(indexPath, 'utf8');
    return (content.match(/^- \[/gm) || []).length;
  } catch {
    return 0;
  }
}

function checkCompactNeeded() {
  return countMemoryEntries() >= COMPACT_THRESHOLD;
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
  const compactNeeded = checkCompactNeeded();

  if (compactNeeded) {
    const msg = `Memory index has reached ${COMPACT_THRESHOLD} entries — compact before stopping (stop #${stopCount}, session ~${Math.round(sessionAge / 60000)}min).\n\nCompact process:\n1. Read all files in .claude/memory/\n2. Distill durable insights into .claude/rules/ rule files (one rule file per topic, e.g. git-conventions.md, code-review.md)\n3. Update any outdated rules already in .claude/rules/\n4. After all insights are captured in rules, clear .claude/rules/MEMORY.md (keep header line, remove all entries)\n\nRules:\n- .claude/memory/ is append-only — NEVER delete memory files\n- Only clear the MEMORY.md index, not the memory files\n- Each rule file should be short, actionable, with "How to apply"`;
    process.stderr.write(msg + '\n', () => process.exit(2));
  } else if (isSimple) {
    const msg = `Please run a session retrospective before stopping (stop #${stopCount}, session ~${Math.round(sessionAge / 60000)}min).\nThis appears to be a lightweight session — briefly summarize what was done. Skip .claude/rules and .claude/memory updates unless something surprising came up.`;
    process.stderr.write(msg + '\n', () => process.exit(2));
  } else {
    const msg = `Please run a session retrospective before stopping (stop #${stopCount}, session ~${Math.round(sessionAge / 60000)}min).\n\nInclude:\n1. What changed and why\n2. How it was validated (tests run, manual checks, edge cases)\n3. Any open blockers or follow-up items\n\nUpdate project memory:\n- .claude/memory/YYYY-MM-DD/ — add/update content files under date directory\n- .claude/rules/MEMORY.md — prepend new entry; keep at most ${COMPACT_THRESHOLD} entries sorted newest-first. Drop the oldest if over ${COMPACT_THRESHOLD}.\n\nSee README.md#memory--rules for the distinction.`;
    process.stderr.write(msg + '\n', () => process.exit(2));
  }
} else {
  process.exit(0);
}
