// session-launcher.mjs — every launch runs the agent through ai-lab's ONE session launcher.
//
// `<python> -m ai_lab.session <claude|codex> [args]` (PLAN-a-short-robust-toolchain P4) mints or inherits
// LAB_SESSION, pins a fresh Claude conversation to it, and runs the agent; cc-config issues no session id.
// `<python>` is the interpreter setup recorded in the provider cache -- the one ai-lab every host-side caller
// uses. No executable on PATH or beside the interpreter is consulted (user ruling 2026-10-25).

import { spawnSync } from 'node:child_process';
import { recordedPython, SETUP_REMEDY } from './provider-cache.mjs';

export const SESSION_MODULE = 'ai_lab.session';
const AGENTS = new Set(['claude', 'codex']);

/** Whether `python` can import the session module (an older ai-lab cannot). */
function hasModule(python, run = spawnSync) {
  const probe = `import importlib.util,sys; sys.exit(importlib.util.find_spec('${SESSION_MODULE}') is None)`;
  const res = run(python, ['-c', probe], { stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
}

/**
 * The spawn of `agent` with `args`: `{ command, args }` through the session launcher, else -- no ai-lab interpreter
 * recorded, or its ai-lab lacks the module -- the agent itself with a `notice` naming the remedy. The session id is
 * an addition to a launch, never its precondition: a stale ai-lab costs the LAB_SESSION, not the session.
 */
export function sessionSpawn(agent, args, { python = recordedPython(), probe = hasModule } = {}) {
  if (!AGENTS.has(agent)) return { error: `${SESSION_MODULE} runs ${[...AGENTS].join(' or ')}, not ${agent}` };
  const why = !python ? 'no ai-lab interpreter recorded in the provider cache'
    : !probe(python) ? `${python} cannot import ${SESSION_MODULE} (an older ai-lab)` : null;
  if (why) {
    return { command: agent, args, notice: `${why}; running ${agent} without a lab session -- upgrade ai-lab and run \`${SETUP_REMEDY}\`` };
  }
  return { command: python, args: ['-m', SESSION_MODULE, agent, ...args] };
}
