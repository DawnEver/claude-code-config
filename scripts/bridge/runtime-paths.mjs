// scripts/bridge/runtime-paths.mjs — where the bridge daemon's machine-local runtime lives.
// Its own module, importing nothing of the bridge: bridge-hook.js runs on every prompt, stop and
// tool call, and loading context.mjs for one path cost ~0.5 s of a cold hook (measured 2026-11-17).

import os from 'os';
import path from 'path';

/** Machine-local runtime dir: daemon port + IPC token + Telegram caches. Never synced. */
export const BRIDGE_RUNTIME_DIR = path.join(os.homedir(), '.claude', 'bridge');
export const RUNTIME_FILE = path.join(BRIDGE_RUNTIME_DIR, 'runtime.json');

/**
 * The mirror spool's files, by name inside a runtime dir (bridge-hook.js writes and delivers them,
 * doctor.js counts them): what hooks append, what the one sender is delivering and how far the
 * daemon acked it, what the daemon refused (held, never dropped), and the sender's lease.
 */
export const SPOOL_NAMES = Object.freeze({
  spool: 'spool.jsonl', inflight: 'spool.inflight.jsonl', cursor: 'spool.inflight.cursor', held: 'spool.held.jsonl', lease: 'spool.lease',
});
