#!/usr/bin/env node
// scripts/bridge/ensure.mjs — make sure exactly one current bridge daemon runs on this machine.
//
//   node scripts/bridge/ensure.mjs        (Claude SessionStart hook; codex.js calls ensureDaemon)
//
// Idempotent by construction, not by luck:
// - the daemon itself takes an exclusive lock file (acquireDaemonLock) before touching
//   Telegram, so concurrent ensures — two sessions starting at once — can spawn at most one
//   survivor; the loser exits 0 without polling.
// - a live daemon running the current source is left alone; one running older source is
//   stopped and replaced (channels and the Codex adapter reconnect on their own).
// - a host without a bot token is a silent no-op.
// Fail-open and silent: hook stdout can inject context, so nothing is printed.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../shared/is-main.mjs';
import { BRIDGE_RUNTIME_DIR, RUNTIME_FILE, bridgeSourceRevision, readBridgeConfig } from './context.mjs';

export const LOCK_FILE = path.join(BRIDGE_RUNTIME_DIR, 'daemon.lock');
const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url));

/** True when `file` was written before this boot: its pid may since belong to anything. */
export const predatesBoot = (file, now = Date.now(), uptime = os.uptime()) => fs.statSync(file).mtimeMs < now - uptime * 1000;

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Exclusive daemon lock: `wx` create holding our pid. A lock whose owner is dead is taken
 * over. Returns a release function, or null when another live daemon holds it.
 */
export function acquireDaemonLock(file = LOCK_FILE, { pid = process.pid, alive = isAlive, stale = predatesBoot } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(pid)) fs.rmSync(file); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number(fs.readFileSync(file, 'utf8'));
      if (owner && owner !== pid && alive(owner) && !stale(file)) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

function spawnDaemon() {
  const log = path.join(BRIDGE_RUNTIME_DIR, 'daemon.log');
  spawn(process.execPath, [DAEMON, '--log', log], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** @returns {'unconfigured'|'running'|'started'|'restarted'} */
export async function ensureDaemon({ runtimeFile = RUNTIME_FILE, configured = () => !!readBridgeConfig().botToken,
  revision = bridgeSourceRevision, alive = isAlive, stale = predatesBoot, kill = (pid) => process.kill(pid), start = spawnDaemon,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!configured()) return 'unconfigured';
  let rt = null;
  try { rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { /* not running */ }
  const pid = rt?.pid;
  if (pid && alive(pid) && !stale(runtimeFile)) {
    if (rt.sourceRevision === revision()) return 'running';
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
  ensureDaemon().catch(() => {}).finally(() => process.exit(0));
}
