// forge-notices.mjs — what the forge found wrong with THIS session's PRs, read through lab-commons.
//
// lab-commons owns the notices (`python -m lab_commons.dev.forge notices --session <id>`, kept in each
// PR's integration comment); this module only asks for them, for the session the launcher issued
// (`LAB_SESSION`, scripts/shared/machine.mjs) in the repo the session runs in. Asked once per session
// start: by the Claude SessionStart hook (scripts/hooks/forge-notices-hook.js) and the Codex launcher
// (codex.js). The per-push read is lab-commons' own pre-push row, not this module.
//
// Never in a session's way: no LAB_SESSION, no repo venv, a forge or network failure, or a timeout all
// read as "no notices" (silent).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** Run the lab-commons verb; its notice lines, or null on any failure (exit 1 means "some", by design). */
function ask({ root, python }, session) {
  const done = spawnSync(python, ['-m', 'lab_commons.dev.forge', 'notices', '--session', session], {
    cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, windowsHide: true,
  });
  if (done.error || (done.status !== 0 && done.status !== 1)) return null;
  return String(done.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * The open notices for `session` in the repo at `cwd`: `{ lines, root }`, or null when there is
 * nothing to say. `run` replaces the lab-commons call (tests).
 */
export function forgeNotices({ session, cwd, run = ask }) {
  if (!session) return null;
  const found = repoPython(cwd);
  if (!found) return null;
  const lines = run(found, session);
  return lines && lines.length ? { lines, root: found.root } : null;
}

/** The notices as one block of context. */
export function render(lines) {
  return [HEADER, ...lines.map((l) => `- ${l}`), 'Fix the head (push a new commit), or ack: python -m lab_commons.dev.forge notices --ack <id>'].join('\n');
}
