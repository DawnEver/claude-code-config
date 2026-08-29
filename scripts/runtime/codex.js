#!/usr/bin/env node
// codex.js — Codex provider launcher.
//
// Thin spawn wrapper around `codex-launcher.mjs`. Same single source of truth as
// the Claude side (`cc.js`): `providers.<name>` in `claude_env_settings.json`.
// Run `node scripts/setup/setup.js` to install the `cods` alias;
// those wrappers exec this script with the provider name.

import { spawn } from 'child_process';
import { statSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { buildCodexInvocation } from './codex-launcher.mjs';
import { prepareSpawn } from './win-spawn.mjs';
import { checkLinks, SETUP_FIX_CMD } from '../setup/check-links.js';

// Read the shared registry through the link setup already materialized, not a repo-relative
// path: claude_env_settings.json lives in the sync payload, which may sit outside the repo.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Prefer the link setup materializes; fall back to the repo-relative path so the launcher
// still works BEFORE the first setup run (where the old repo-relative resolution used to).
function resolveEnvSettingsPath() {
  const linked = join(homedir(), '.claude', 'claude_env_settings.json');
  if (existsSync(linked)) return linked;
  return join(REPO_ROOT, 'claude_env_settings.json');
}

const envSettingsPath = resolveEnvSettingsPath();

// Throttle the link-health check: on a OneDrive-backed Windows FS, a cold-cache
// `stat` per link can block for hundreds of ms. The check is essential after
// OneDrive sync-downs or `git checkout`s but pointless to run on every TUI
// launch. mtime < 24h old → skip; otherwise run + touch the stamp.
const LINK_CHECK_STAMP = join(homedir(), '.codex', '.link-check');
const LINK_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
function isLinkCheckFresh() {
  try {
    return (Date.now() - statSync(LINK_CHECK_STAMP).mtimeMs) < LINK_CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}
function touchLinkCheckStamp() {
  try {
    writeFileSync(LINK_CHECK_STAMP, '');
  } catch {
    // best-effort
  }
}

// Codex has no session-start hook, so the launcher doubles as the link-health
// checkpoint (Claude Code's side is scripts/hooks/setup-check-hook.js).
if (!isLinkCheckFresh()) {
  try {
    const { repaired, warnings } = checkLinks();
    if (repaired.length) console.error(`[setup-check] re-linked: ${repaired.join(', ')}`);
    if (warnings.length) console.error(`[setup-check] needs manual setup: ${warnings.join('; ')} — fix: ${SETUP_FIX_CMD}`);
    touchLinkCheckStamp();
  } catch {
    // Link checking must never block a launch.
  }
}

const argv = process.argv.slice(2);
const provider = argv[0] && !argv[0].startsWith('-') ? argv.shift() : '';
const extraArgs = argv;

const { env, args, error } = buildCodexInvocation({
  provider: provider || null,
  extraArgs,
  envSettingsPath,
});

if (error) {
  console.error(error);
  process.exit(1);
}

console.log(provider ? `[codex] Using provider: ${provider}` : '[codex] Using default Codex');

// Not `shell: true`: that concatenates args unescaped, so `cods exec "a prompt with spaces"`
// reached Codex as separate words. `prepareSpawn` resolves the npm shim and quotes for us.
const launch = prepareSpawn('codex', args, { env });
const child = spawn(launch.command, launch.args, { ...launch.options, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
