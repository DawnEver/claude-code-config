#!/usr/bin/env node
// scripts/bridge/ensure.mjs — make sure exactly one current bridge daemon runs on this machine.
//
//   node scripts/bridge/ensure.mjs        (Claude SessionStart hook; codex.js calls ensureDaemon)
//
// Idempotent by construction, not by luck:
// - the daemon itself takes an exclusive lock file (acquireDaemonLock) before touching
//   Telegram, so concurrent ensures — two sessions starting at once — can spawn at most one
//   survivor; the loser exits 0 without polling.
// - a live daemon running the current source and config is left alone; one running older ones is
//   stopped and replaced (channels and the Codex adapter reconnect on their own).
// - a host without a bot token is a silent no-op.
// Fail-open and silent: hook stdout can inject context, so nothing is printed.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../shared/is-main.mjs';
import { resolveCodexHome, recordCodexHome } from '../shared/codex-home.mjs';
import { bridgeSourceRevision, bridgeConfigRevision, readBridgeConfig } from './context.mjs';
import { BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './runtime-paths.mjs';
import { acquireOwnerLock, isAlive, predatesBoot } from '../shared/owner-lock.mjs';

const LOCK_FILE = path.join(BRIDGE_RUNTIME_DIR, 'daemon.lock');
const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url));

/**
 * Exclusive daemon lock (shared/owner-lock.mjs): `wx` create holding our pid; a lock whose owner
 * is dead, or recorded before this boot, is taken over. Returns a release function, or null when
 * another live daemon holds it.
 */
export const acquireDaemonLock = (file = LOCK_FILE, opts = {}) => acquireOwnerLock(file, opts);

const LOG_FILE = path.join(BRIDGE_RUNTIME_DIR, 'daemon.log');
function spawnDaemon() {
  spawn(process.execPath, [DAEMON, '--log', LOG_FILE], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
/** One line in the daemon's log, in its format: a replacement is never silent. */
function logLine(message) {
  try { fs.appendFileSync(LOG_FILE, `[bridge ${new Date().toISOString()}] ${message}
`); } catch { /* the log is best effort */ }
}

/**
 * Cheap liveness check for hot paths (a Codex tool call): the runtime file's pid is alive.
 * No source hashing — a stale-but-alive daemon hands itself over within a minute anyway.
 */
export function daemonRunning({ runtimeFile = RUNTIME_FILE, alive = isAlive, stale = predatesBoot } = {}) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    return !!pid && alive(pid) && !stale(runtimeFile);
  } catch { return false; }
}

/**
 * Start the daemon when none runs. A running one whose source or config changed is left to hand
 * itself over (its own check, within a minute): replacing it here, on every session start, made
 * a burst of starts (subagents, reviewers) during an edit restart it every few seconds. Only
 * `replace` — the daemon's own handover, or a pull that must serve the pulled code now — kills it.
 * `codexHome`, the home this launch runs in, is recorded for the daemon to follow (codex-home.mjs).
 * @returns {'unconfigured'|'running'|'stale'|'started'|'restarted'}
 */
export async function ensureDaemon({ replace = false, log = logLine, runtimeFile = RUNTIME_FILE, configured = () => { const c = readBridgeConfig(); return !!(c.botToken || c.dashboard); }, codexHome = resolveCodexHome(), record = recordCodexHome,
  revision = bridgeSourceRevision, configRevision = bridgeConfigRevision, alive = isAlive, stale = predatesBoot, kill = (pid) => process.kill(pid), start = spawnDaemon,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!configured()) return 'unconfigured';
  record(codexHome);
  let rt = null;
  try { rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { /* not running */ }
  const pid = rt?.pid;
  if (pid && alive(pid) && !stale(runtimeFile)) {
    // The daemon reads its config once: a config change replaces it like a source change.
    if (rt.sourceRevision === revision() && rt.configRevision === configRevision()) return 'running';
    if (!replace) return 'stale';
    log(`ensure: replacing daemon ${pid} (source or config changed)`);
    try { kill(pid); } catch { /* already gone */ }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    start();
    return 'restarted';
  }
  start();
  return 'started';
}

if (isMain(import.meta.url)) {
  setTimeout(() => process.exit(0), 8000).unref();
  ensureDaemon({ replace: process.argv.includes('--replace') }).catch(() => {}).finally(() => process.exit(0));
}
