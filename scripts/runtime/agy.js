#!/usr/bin/env node
// agy.js - Antigravity CLI launcher (`agyc`).
//
// Thin spawn wrapper around `agy-launcher.mjs`, like codex.js: pull the checkout before any
// repo module loads, heal setup links, ensure the session bridge, then run agy with this
// host's provenance env. The managed agy hooks (scripts/hooks/agy-hook.mjs) do the same at
// SessionStart for a bare `agy`; CC_CONFIG_STARTUP_SYNCED=1 tells them it already happened.

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { syncBeforeLaunch } from './startup-sync.mjs';

const sync = syncBeforeLaunch({ env: { ...process.env, CC_CONFIG_STARTUP_SYNCED: '' },
  stampFile: join(homedir(), '.claude', '.harness-startup-sync') });
if (sync.notice) console.error(sync.notice);
process.env.CC_CONFIG_STARTUP_SYNCED = '1';
const [{ buildAgyInvocation, resolveAgySpawn }, { prepareSpawn }, { checkLinks, SETUP_FIX_CMD }] = await Promise.all([
  import('./agy-launcher.mjs'),
  import('./win-spawn.mjs'),
  import('../setup/check-links.js'),
]);

if (sync.pulled > 0) {
  try {
    const { repaired, warnings } = checkLinks();
    if (repaired.length) console.error(`[setup-check] re-linked: ${repaired.join(', ')}`);
    if (warnings.length) console.error(`[setup-check] needs manual setup: ${warnings.join('; ')} - fix: ${SETUP_FIX_CMD}`);
  } catch { /* link checking must never block a launch */ }
}

try {
  await (await import('../bridge/ensure.mjs')).ensureDaemon();
} catch { /* the bridge must never block a launch */ }

const { env: launchEnv, args } = buildAgyInvocation({ extraArgs: process.argv.slice(2) });
const run = resolveAgySpawn(args, launchEnv, { log: (m) => console.error(`[agy] ${m}`) });
if (run.notice) console.error(`[agy] ${run.notice}`);
const launch = prepareSpawn(run.command, run.args, { env: run.env });
const child = spawn(launch.command, launch.args, { ...launch.options, env: run.env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
