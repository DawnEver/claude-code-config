// session-launcher.mjs — every launch runs the agent through ai-lab's ONE session launcher.
//
// `ai-lab-session <claude|codex> [args]` (ai-lab `ai_lab.session`, PLAN-a-short-robust-toolchain P4) mints or
// inherits LAB_SESSION, pins a fresh Claude conversation to it, and runs the agent; cc-config issues no session id.
// It is the console script of the ai-lab install setup pinned for the provider cache, so it is found beside that
// interpreter (venv `Scripts/` on Windows, `bin/` elsewhere) -- the one ai-lab every host-side caller uses.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordedPython, SETUP_REMEDY } from './provider-cache.mjs';

export const SESSION_LAUNCHER = 'ai-lab-session';
const AGENTS = new Set(['claude', 'codex']);

/**
 * The spawn of `agent` with `args` through the session launcher: `{ command, args }`, or `{ error }` naming the
 * remedy when no ai-lab interpreter is recorded or its install lacks the launcher.
 */
export function sessionSpawn(agent, args, { python = recordedPython(), platform = process.platform } = {}) {
  if (!AGENTS.has(agent)) return { error: `${SESSION_LAUNCHER} runs ${[...AGENTS].join(' or ')}, not ${agent}` };
  if (!python) return { error: `no ai-lab interpreter recorded in the provider cache; run \`${SETUP_REMEDY}\`` };
  const command = join(dirname(python), platform === 'win32' ? `${SESSION_LAUNCHER}.exe` : SESSION_LAUNCHER);
  if (!existsSync(command)) {
    return { error: `${SESSION_LAUNCHER} is not installed beside ${python} (an ai-lab without it); upgrade ai-lab and run \`${SETUP_REMEDY}\`` };
  }
  return { command, args: [agent, ...args] };
}
