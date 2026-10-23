// scripts/shared/machine.mjs — this host's fleet name and the provenance env it implies.
//
// `~/.claude/machine.json` = {"name": "<NAME>"} is machine-local: never in the repo, never
// in the sync payload, never derived from hostname. `setup.js --machine <NAME>` writes it;
// the launchers and doctor read it through here. See docs/harness-architecture.md §8b.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { sessionIdentity } from './session-identity.mjs';

export const MACHINE_PATH = path.join(os.homedir(), '.claude', 'machine.json');
export const MACHINE_FIX_CMD = 'node scripts/setup/setup.js --machine <NAME>';

export function isValidMachineName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9-]+$/.test(name);
}

/** The configured machine name, or null when absent/unparsable/invalid. */
export function readMachineName(file = MACHINE_PATH) {
  try {
    const { name } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isValidMachineName(name) ? name : null;
  } catch {
    return null;
  }
}

export function writeMachineName(name, file = MACHINE_PATH) {
  if (!isValidMachineName(name)) throw new Error(`invalid machine name: ${JSON.stringify(name)} (allowed: [A-Za-z0-9-]+)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name }, null, 2) + '\n');
}

/** Prefer a configured global name; otherwise use Git's effective author identity.
 * Reading it never edits the user's profile, email or author environment. */
export function readGitUserName(run = execFileSync) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
  try { const name = run('git', ['config', '--global', 'user.name'], options).trim(); if (name) return name; } catch { /* no global setting */ }
  try { return /^(.+) <[^<>]*> \d+ [+-]\d+$/.exec(run('git', ['var', 'GIT_AUTHOR_IDENT'], options).trim())?.[1] || null; }
  catch { return null; }
}

/**
 * Env vars a launcher adds so commits and tools can tell which machine/agent acted.
 * Only the committer is changed — the author stays the accountable person — and the
 * vars exist only inside launcher-started processes, so manual commits are untouched.
 *
 * A GIT_COMMITTER_NAME already in `env` is kept when the user set it themselves. One
 * inherited from an outer launcher (marked by HARNESS_AGENT being present too) is
 * replaced, so a nested `ccc` inside a `codc` session reports the inner agent.
 */
export function provenanceEnv({ machine, agent, userName, env = process.env }) {
  if (!machine) return {};
  const out = { HARNESS_MACHINE: machine, HARNESS_AGENT: agent };
  const userSet = env.GIT_COMMITTER_NAME && !env.HARNESS_AGENT;
  if (userName && !userSet) out.GIT_COMMITTER_NAME = `${userName} (${machine}/${agent})`;
  return out;
}

/** Vendor-neutral root lineage for consumers; native execution identity remains separate. */
export const SESSION_ENV = 'LAB_SESSION';

/**
 * Native runtime lineage wins over a launcher fallback. Outside a runtime, preserve an
 * inherited id, the resumed vendor id, or issue a launcher UUID for a fresh conversation.
 * Never in codexShellEnv: a
 * static config.toml would give every session the same id.
 */
export function sessionEnv(env = process.env, vendorId = null) {
  return { [SESSION_ENV]: sessionIdentity(env).sessionId || vendorId || randomUUID() };
}

/**
 * Provenance for Codex, written by setup into ~/.codex/config.toml as
 * `[shell_environment_policy.set]`. Codex may run commands in a shared app-server daemon
 * started by anything (desktop app, VS Code, an earlier session), so launcher env cannot
 * reach them; config can. A static file cannot see the caller's shell, so a user-set
 * GIT_COMMITTER_NAME is NOT preserved: Codex commands always tag.
 */
export function codexShellEnv({ machine = readMachineName(), userName = machine ? readGitUserName() : null } = {}) {
  return provenanceEnv({ machine, agent: 'codex', userName, env: {} });
}
