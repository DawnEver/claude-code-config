#!/usr/bin/env node
// review-gate-hook.js — Claude Code Stop hook
// A haiku classifier decides how many rounds of sharp critique to run.
// Modes: none | once | triple. Skips for trivial/non-code tasks.

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const homeDir = process.env.HOME || process.env.USERPROFILE || '';

const stateFile = path.join(projectDir, '.claude', '.review-gate-state.json');
const projectMemFile = path.join(projectDir, '.claude', '.review-gate-memory.json');
const globalMemFile = path.join(homeDir, '.claude', '.review-gate-memory.json');
const MEMORY_MAX = 20;
const TARGETS = { none: 0, once: 1, triple: 3 };

function readStdinJSON() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

function loadJSON(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

function saveJSON(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function resolveMemFile() {
  return fs.existsSync(projectMemFile) ? projectMemFile : globalMemFile;
}

function loadMemory() {
  return loadJSON(resolveMemFile()) || [];
}

function appendMemory(entry) {
  const file = resolveMemFile();
  let mem = loadJSON(file) || [];
  mem.push(entry);
  if (mem.length > MEMORY_MAX) mem = mem.slice(-MEMORY_MAX);
  saveJSON(file, mem);
}

function getChangedFiles() {
  try {
    const out = execSync('git status --porcelain', { cwd: projectDir, timeout: 5000 }).toString();
    return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}

const DOC_ONLY_PATTERNS = [/\.md$/i, /^memories\//, /^\.claude\//, /^MEMORY\.md$/i, /^README/i];

function isDocOnly(files) {
  return files.length > 0 && files.every(f => DOC_ONLY_PATTERNS.some(p => p.test(f)));
}

function readTranscriptTail(transcriptPath, maxLines = 40) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function hasCodeEdits(transcript) {
  return transcript.some(entry => {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some(block =>
      block?.type === 'tool_use' &&
      ['Edit', 'Write', 'NotebookEdit'].includes(block?.name)
    );
  });
}

function extractTaskSummary(transcript) {
  const msgs = transcript
    .filter(e => e?.message?.role === 'assistant')
    .flatMap(e => {
      const c = e?.message?.content;
      return Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text) : [];
    })
    .join(' ')
    .slice(0, 800);
  return msgs || '(no summary)';
}

function classify(taskSummary, changedFiles, memory) {
  const examples = memory.slice(-5).map(m =>
    `Task: ${m.task.slice(0, 120)}\nFiles: ${(m.files || []).join(', ')}\nMode: ${m.mode}`
  ).join('\n---\n');

  const prompt = `You are a code review gate classifier. Decide how many rounds of critique to run.

Modes:
- none: trivial task, no code logic changed, or purely informational
- once: moderate code change, single review pass is enough
- triple: complex multi-file change, algorithm change, or high-risk logic

${examples ? `Past examples:\n${examples}\n---\n` : ''}Current task summary:
${taskSummary}

Changed files: ${changedFiles.join(', ') || 'none'}

Respond ONLY with valid JSON: {"mode": "none"|"once"|"triple", "reason": "one sentence"}`;

  try {
    const result = spawnSync('claude', ['-p', prompt, '--max-tokens', '80'], {
      env: { ...process.env, SHARP_REVIEW_CLASSIFY: '1' },
      timeout: 15000,
      encoding: 'utf8',
    });
    const text = result.stdout || '';
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const mode = ['none', 'once', 'triple'].includes(parsed.mode) ? parsed.mode : 'once';
    return { mode, reason: parsed.reason || '' };
  } catch {
    return { mode: 'once', reason: 'classifier error' };
  }
}

async function main() {
  if (process.env.SHARP_REVIEW_CLASSIFY) process.exit(0);

  const input = readStdinJSON();

  if (input.stop_hook_active) process.exit(0);

  const sessionId = input.session_id || '';
  const transcriptPath = input.transcript_path || '';

  const transcript = transcriptPath ? readTranscriptTail(transcriptPath) : [];
  const changedFiles = getChangedFiles();

  if (isDocOnly(changedFiles) || (changedFiles.length === 0 && !hasCodeEdits(transcript))) {
    process.exit(0);
  }

  const now = Date.now();
  let state = loadJSON(stateFile);
  const isFresh = !state || state.sessionId !== sessionId;

  if (isFresh) {
    const taskSummary = extractTaskSummary(transcript);
    const memory = loadMemory();
    let classification;
    try {
      classification = classify(taskSummary, changedFiles, memory);
    } catch {
      classification = { mode: 'once', reason: 'classifier error' };
    }

    state = {
      sessionId,
      mode: classification.mode,
      reason: classification.reason,
      reviewCount: 0,
      classifiedAt: now,
    };
    saveJSON(stateFile, state);

    appendMemory({ task: extractTaskSummary(transcript).slice(0, 200), files: changedFiles.slice(0, 10), mode: classification.mode });
  }

  const target = TARGETS[state.mode] ?? 1;

  if (state.reviewCount >= target) {
    process.exit(0);
  }

  state.reviewCount += 1;
  saveJSON(stateFile, state);

  process.stderr.write('/sharp-review\n', () => process.exit(2));
}

main().catch(() => process.exit(0));
