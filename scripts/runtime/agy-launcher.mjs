// scripts/runtime/agy-launcher.mjs - pure helper for the `agy.js` launcher (`agyc`).
//
// agy (Antigravity CLI) picks its own models and account, so unlike cc-launcher / codex-launcher
// there is no provider projection: the launcher adds only this host's provenance
// (HARNESS_MACHINE / HARNESS_AGENT=agy / committer name, scripts/shared/machine.mjs).
// Session lineage (`LAB_SESSION`) is owned exclusively by `ai_lab.session`.

import { readMachineName, readGitUserName, provenanceEnv } from '../shared/machine.mjs';

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
