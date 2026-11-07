// session-launcher.mjs — every launch runs the agent through ai-lab's ONE session launcher.
//
// `<python> -m ai_lab.session <claude|codex> [args]` (PLAN-a-short-robust-toolchain P4) mints or inherits
// LAB_SESSION, pins a fresh Claude conversation to it, and runs the agent; cc-config issues no session id.
// `<python>` is the interpreter setup recorded in the provider cache -- the one ai-lab every host-side caller
// uses. No executable on PATH or beside the interpreter is consulted (user ruling 2026-10-25).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordedPython, SETUP_REMEDY } from './provider-cache.mjs';

export const SESSION_MODULE = 'ai_lab.session';
const AGENTS = new Set(['claude', 'codex']);

/** Import the session module for real: `{ok: true}`, or `{ok: false, why}` with Python's last stderr line. */
function importProbe(python, run = spawnSync) {
  const res = run(python, ['-c', `import ${SESSION_MODULE}`],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  if (!res.error && res.status === 0) return { ok: true };
  const why = res.error ? res.error.message : String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`;
  return { ok: false, why };
}

/** The uv project whose `.venv` holds `python` (`<project>/.venv/{Scripts,bin}/python`), or null. */
function venvProject(python) {
  const project = dirname(dirname(dirname(python)));
  return existsSync(join(project, 'pyproject.toml')) && existsSync(join(project, 'uv.lock')) ? project : null;
}

/** Bring the venv up to the tree's lock; `--inexact` leaves what a concurrent session may still import. */
function uvSync(project, run = spawnSync) {
  const res = run('uv', ['sync', '--frozen', '--quiet', '--inexact'],
    { cwd: project, stdio: 'ignore', windowsHide: true, timeout: 600000 });
  return !res.error && res.status === 0;
}

const stat = (p) => { try { const s = statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } };

/**
 * What the importability of `python` depends on, from stats alone (no process): the interpreter, the lock and
 * pyproject of its project, and the commit its branch ref points at. Unchanged since a verified launch means the
 * import still works; anything that moves the tree or the lock changes it.
 */
export function venvFingerprint(python, dir) {
  const parts = [python, stat(python)];
  if (dir) {
    parts.push(stat(join(dir, 'uv.lock')), stat(join(dir, 'pyproject.toml')));
    try {
      const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
      const ref = head.startsWith('ref: ') ? head.slice(5) : null;
      parts.push(head, ref ? `${stat(join(dir, '.git', ref))}|${stat(join(dir, '.git', 'packed-refs'))}` : '');
    } catch { parts.push('no-git'); }
  }
  return parts.join('\n');
}

const VERIFIED_FILE = join(homedir(), '.claude', 'ai-lab-venv-verified');
const readVerified = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const writeVerified = (file, fp) => { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, fp); } catch { /* a cache */ } };

/**
 * Whatever moved the ai-lab tree -- the background update, a manual pull, ai-lab's own tooling -- its venv must
 * import the code now on disk. A launch whose fingerprint matches the last verified one skips the ~0.4 s import;
 * otherwise a failed import from a uv project's venv is answered by syncing that venv to the tree's lock and
 * probing again; `log` reports the repair.
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function ensureImportable(python, {
  probe = importProbe, project = venvProject, sync = uvSync, log = () => {}, verified = VERIFIED_FILE,
} = {}) {
  const dir = project(python);
  const fp = venvFingerprint(python, dir);
  if (verified && readVerified(verified) === fp) return { ok: true };
  let result = probe(python);
  if (!result.ok && dir) {
    log(`ai-lab cannot import ${SESSION_MODULE} (${result.why}); syncing its venv to the lock`);
    result = sync(dir) ? probe(python) : { ok: false, why: `${result.why}; uv sync in ${dir} failed` };
  }
  if (result.ok && verified) writeVerified(verified, venvFingerprint(python, dir));
  return result;
}

/**
 * The spawn of `agent` with `args`: `{ command, args }` through the session launcher, else -- no ai-lab interpreter
 * recorded, or its ai-lab cannot import the module even after a venv sync -- the agent itself with a `notice` naming
 * the remedy. The session id is an addition to a launch, never its precondition: a broken ai-lab costs the
 * LAB_SESSION, not the session.
 */
export function sessionSpawn(agent, args, { python = recordedPython(), ensure = ensureImportable, log = () => {} } = {}) {
  if (!AGENTS.has(agent)) return { error: `${SESSION_MODULE} runs ${[...AGENTS].join(' or ')}, not ${agent}` };
  let why = !python ? 'no ai-lab interpreter recorded in the provider cache' : null;
  if (!why) {
    const ready = ensure(python, { log });
    if (!ready.ok) why = `${python} cannot import ${SESSION_MODULE} (${ready.why})`;
  }
  if (why) {
    return { command: agent, args, notice: `${why}; running ${agent} without a lab session -- fix ai-lab and run \`${SETUP_REMEDY}\`` };
  }
  return { command: python, args: ['-m', SESSION_MODULE, agent, ...args] };
}
