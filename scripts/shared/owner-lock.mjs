// scripts/shared/owner-lock.mjs — a lock file that names its owner, for the one-at-a-time jobs:
// the bridge daemon and doctor's detached refresh.
// A lock is only ever held by a LIVE owner: one whose pid is dead (killed with its tree, a crash)
// is taken over at once, never waited out. A pid recorded before this boot may since belong to
// anything, and `maxAgeMs` bounds even a live owner (a hung job, a reused pid).

import fs from 'fs';
import os from 'os';
import path from 'path';

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** True when `file` was written before this boot: its pid may since belong to anything. */
export const predatesBoot = (file, now = Date.now(), uptime = os.uptime()) => fs.statSync(file).mtimeMs < now - uptime * 1000;

/** Is `file` held by a live owner? A missing, torn, dead-owner, pre-boot or over-age lock is not. */
export function ownerLockLive(file, { alive = isAlive, stale = predatesBoot, maxAgeMs = Infinity, now = Date.now() } = {}) {
  try {
    const owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    if (!(owner > 0) || !alive(owner)) return false;
    if (stale(file)) return false;
    return now - fs.statSync(file).mtimeMs < maxAgeMs;
  } catch { return false; }
}

/**
 * Take `file` for `pid` (exclusive `wx` create); a lock no live owner holds is taken over at once.
 * Returns a release function (it removes the lock only while it is still ours), or null when a
 * live owner holds it.
 */
export function acquireOwnerLock(file, { pid = process.pid, alive = isAlive, stale = predatesBoot, maxAgeMs = Infinity, now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(pid)) fs.rmSync(file); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = 0;
      try { owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10); } catch { continue; /* released meanwhile */ }
      if (owner !== pid && ownerLockLive(file, { alive, stale, maxAgeMs, now })) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}
