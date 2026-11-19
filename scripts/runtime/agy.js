#!/usr/bin/env node
// agy.js - Antigravity CLI launcher (`agyc`).
//
// Thin spawn wrapper around `agy-launcher.mjs`, matching `codex.js`: pull the checkout before any
// repo module loads, heal setup links, ensure the session bridge, then run `agy` through ai-lab's
// `ai_lab.session` launcher with this host's provenance env.

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { syncBeforeLaunch } from './startup-sync.mjs';

const sync = syncBeforeLaunch({ env: { ...process.env, CC_CONFIG_STARTUP_SYNCED: '' },
  stampFile: join(homedir(), '.claude', '.harness-startup-sync') });
if (sync.notice) console.error(sync.notice);
process.env.CC_CONFIG_STARTUP_SYNCED = '1';
const [{ buildAgyInvocation }, { prepareSpawn }, { checkLinks, SETUP_FIX_CMD }, { sessionSpawn }] = await Promise.all([
  import('./agy-launcher.mjs'),
  import('./win-spawn.mjs'),
  import('../setup/check-links.js'),
  import('../shared/session-launcher.mjs'),
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
const session = sessionSpawn('agy', args, { log: (m) => console.error(`[agy] ${m}`) });
if (session.error) {
  console.error(session.error);
  process.exit(1);
}
if (session.notice) console.error(`[agy] ${session.notice}`);
const launch = prepareSpawn(session.command, session.args, { env: launchEnv });
const child = spawn(launch.command, launch.args, { ...launch.options, env: launchEnv, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
