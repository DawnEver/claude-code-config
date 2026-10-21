// forge-notices.mjs — what the forge found wrong with THIS session's PRs, read through lab-commons.
//
// lab-commons owns the notices (`python -m lab_commons.dev.forge notices --session <id>`, kept in each
// PR's integration comment); this module only asks for them, for the session the launcher issued
// (`LAB_SESSION`, scripts/shared/machine.mjs) in the repo the session runs in. Used by the Claude hook
// (scripts/hooks/forge-notices-hook.js, SessionStart + Stop) and the Codex launcher (codex.js).
//
// Never in a turn's way: no LAB_SESSION, no repo venv, a forge or network failure, or a timeout all
// read as "no notices" (silent). The answer is cached ~60 s per (session, repo), so a Stop after every
// turn costs one file read, not a forge round-trip.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CACHE_MS = 60_000;
export const RUN_TIMEOUT_MS = 8_000;
export const HEADER = 'forge notices for your PRs:';

/** The repo venv's python at or above `cwd` (the checkout the session runs in), or null. */
export function repoPython(cwd) {
  let dir = cwd;
  for (;;) {
    for (const rel of [join('.venv', 'Scripts', 'python.exe'), join('.venv', 'bin', 'python')]) {
      if (existsSync(join(dir, rel))) return { root: dir, python: join(dir, rel) };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Run the lab-commons verb; its notice lines, or [] on any failure (exit 1 means "some", by design). */
function ask({ root, python }, session) {
  const done = spawnSync(python, ['-m', 'lab_commons.dev.forge', 'notices', '--session', session], {
    cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, windowsHide: true,
  });
  if (done.error || (done.status !== 0 && done.status !== 1)) return null;
  return String(done.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * The open notices for `session` in the repo at `cwd`: `{ lines, root }`, or null when there is
 * nothing to say. `run` replaces the lab-commons call and `now` the clock (tests).
 */
export function forgeNotices({ session, cwd, now = Date.now(), run = ask, cacheDir = join(tmpdir(), 'forge-notices') }) {
  if (!session) return null;
  const found = repoPython(cwd);
  if (!found) return null;
  const key = createHash('sha256').update(`${session}\0${found.root}`).digest('hex').slice(0, 16);
  const file = join(cacheDir, `${key}.json`);
  let cached = null;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no cache yet */ }
  let lines = cached && now - cached.at < CACHE_MS ? cached.lines : null;
  if (lines === null) {
    lines = run(found, session);
    if (lines === null) lines = cached ? cached.lines : [];  // a failed read keeps the last answer, never blocks
    else {
      try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify({ at: now, lines, told: cached?.told || [] })); } catch { /* cache is optional */ }
    }
  }
  return lines.length ? { lines, root: found.root, file } : null;
}

/** The notices as one block of context. */
export function render(lines) {
  return [HEADER, ...lines.map((l) => `- ${l}`), 'Fix the head (push a new commit), or ack: python -m lab_commons.dev.forge notices --ack <id>'].join('\n');
}

/** The lines not yet told to this session (and record them as told): what a Stop hook surfaces once. */
export function untold(result) {
  let state = {};
  try { state = JSON.parse(readFileSync(result.file, 'utf8')); } catch { /* none */ }
  const told = new Set(state.told || []);
  const id = (line) => line.split(':')[0];
  const fresh = result.lines.filter((l) => !told.has(id(l)));
  if (fresh.length) {
    try { writeFileSync(result.file, JSON.stringify({ ...state, told: [...told, ...fresh.map(id)] })); } catch { /* optional */ }
  }
  return fresh;
}
