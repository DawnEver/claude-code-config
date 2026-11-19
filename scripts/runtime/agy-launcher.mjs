// scripts/runtime/agy-launcher.mjs - pure helper for the `agy.js` launcher (`agyc`).
//
// agy (Antigravity CLI) picks its own models and account, so unlike cc-launcher / codex-launcher
// there is no provider projection: the launcher adds only this host's provenance
// (HARNESS_MACHINE / HARNESS_AGENT=agy / committer name, scripts/shared/machine.mjs) and
// resolves how to run the binary through ai-lab's session launcher.

import { randomUUID } from 'node:crypto';
import { readMachineName, readGitUserName, provenanceEnv } from '../shared/machine.mjs';
import { sessionSpawn as defaultSessionSpawn } from '../shared/session-launcher.mjs';

export const AGY_BINARY = 'agy';

/**
 * @param {object} opts
 * @param {string[]} [opts.extraArgs]  passed through to agy unchanged
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string|null} [opts.machine]   machine name (machine.json)
 * @param {string|null} [opts.gitUserName]
 * @returns {{ env: NodeJS.ProcessEnv, args: string[] }}
 */
export function buildAgyInvocation({ extraArgs = [], env = process.env, machine = readMachineName(), gitUserName } = {}) {
  const out = { ...env };
  if (gitUserName === undefined) gitUserName = machine ? readGitUserName() : null;
  Object.assign(out, provenanceEnv({ machine, agent: 'agy', userName: gitUserName, env }));
  return { env: out, args: [...extraArgs] };
}

/**
 * The command that runs agy. ai-lab's `ai_lab.session` owns LAB_SESSION; until it accepts agy
 * (sessionSpawn returns an error for an agent it does not run) agy runs directly and the
 * launcher carries a lab session itself: inherited LAB_SESSION, else a fresh UUID.
 * @returns {{ command: string, args: string[], env: NodeJS.ProcessEnv, notice?: string }}
 */
export function resolveAgySpawn(args, env, { sessionSpawn = defaultSessionSpawn, log = () => {}, uuid = randomUUID } = {}) {
  const session = sessionSpawn(AGY_BINARY, args, { log });
  if (!session.error) return { command: session.command, args: session.args, env, notice: session.notice };
  return { command: AGY_BINARY, args, env: { ...env, LAB_SESSION: env.LAB_SESSION || uuid() },
    notice: `${session.error}; running agy directly` };
}
