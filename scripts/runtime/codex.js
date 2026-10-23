#!/usr/bin/env node
// codex.js — Codex provider launcher.
//
// Thin spawn wrapper around `codex-launcher.mjs`: the provider cache (ai-lab's catalogue),
// the projection rules in `claude_env_settings.json`, the key from the git credential store.
// Run `node scripts/setup/setup.js` to install the `cods` alias;
// those wrappers exec this script with the provider name.

import { spawn } from 'child_process';
import { statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { syncBeforeLaunch } from './startup-sync.mjs';

// Claude's user SessionStart wiring is not projected into Codex. Synchronize here,
// before loading repo-owned modules or reading the shared provider config.
const sync = syncBeforeLaunch({ env: { ...process.env, CC_CONFIG_STARTUP_SYNCED: '' },
  stampFile: join(homedir(), '.claude', '.harness-startup-sync') });
if (sync.notice) console.error(sync.notice);
process.env.CC_CONFIG_STARTUP_SYNCED = '1';
const [{ buildCodexInvocation }, { prepareSpawn }, { checkLinks, SETUP_FIX_CMD },
  { ENV_SETTINGS_PATH }, { resolveCodexHome }] = await Promise.all([
  import('./codex-launcher.mjs'),
  import('./win-spawn.mjs'),
  import('../setup/check-links.js'),
  import('../shared/config.mjs'),
  import('../shared/codex-home.mjs'),
]);
const activeCodexHome = resolveCodexHome();

// Read the shared registry through the link setup already materialized, not a repo-relative
// path: claude_env_settings.json lives in the sync payload, which may sit outside the repo.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Prefer the link setup materializes; fall back to the repo-relative path so the launcher
// still works BEFORE the first setup run (where the old repo-relative resolution used to).
const envSettingsPath = ENV_SETTINGS_PATH;

// Throttle the link-health check: the links point into the sync payload's cloud folder, where
// a cold-cache `stat` per link costs 150-300 ms (measured). The check matters after a cloud
// sync-down or a pull, not on every TUI launch: a pull always runs it; otherwise at most daily.
const LINK_CHECK_STAMP = join(activeCodexHome, '.link-check');
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

// This repo wires Codex's link-health checkpoint into the launcher, not a Codex
// hook (Claude Code's side is scripts/hooks/setup-check-hook.js).
if (sync.pulled > 0 || !isLinkCheckFresh()) {
  try {
    const { repaired, warnings } = checkLinks();
    if (repaired.length) console.error(`[setup-check] re-linked: ${repaired.join(', ')}`);
    if (warnings.length) console.error(`[setup-check] needs manual setup: ${warnings.join('; ')} — fix: ${SETUP_FIX_CMD}`);
    touchLinkCheckStamp();
  } catch {
    // Link checking must never block a launch.
  }
}

// Ensure the bridge at this managed Codex entry point; plugin hooks are separate.
try {
  const { ensureDaemon } = await import('../bridge/ensure.mjs');
  if (await ensureDaemon() === 'different-home')
    console.error('[harness] The machine collector belongs to another CODEX_HOME; accounts were not mixed.');
} catch {
  // The bridge must never block a launch.
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
