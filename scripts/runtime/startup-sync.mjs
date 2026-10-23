import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const DEFAULT_HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'sync-hook.js');

/**
 * Run repository synchronization in a separate process before loading any
 * repo-owned launcher modules. A fast-forward can replace those modules, so
 * importing them first would run a mixture of old and new code.
 */
export function syncBeforeLaunch({
  hookPath = DEFAULT_HOOK,
  nodePath = process.execPath,
  env = process.env,
  spawn = spawnSync,
  stampFile = null,
  now = Date.now,
} = {}) {
  if (env.CC_CONFIG_STARTUP_SYNCED === '1') return { notice: null, skipped: true };

  // Wrapper and daemon hooks do not necessarily share env. A short machine-local
  // lease prevents concurrent startups from fetching/updating this checkout twice.
  let release = () => {};
  if (stampFile) {
    const lock = `${stampFile}.lock`;
    try {
      if (now() - fs.statSync(stampFile).mtimeMs < 60000) return { notice: null, skipped: true };
    } catch { /* first startup */ }
    try {
      fs.mkdirSync(dirname(stampFile), { recursive: true });
      try { if (now() - fs.statSync(lock).mtimeMs > 120000) fs.unlinkSync(lock); } catch { /* absent */ }
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      release = () => { try { fs.unlinkSync(lock); } catch { /* gone */ } };
    } catch { return { notice: null, skipped: true }; }
  }

  let result;
  try { result = spawn(nodePath, [hookPath, '--pull'], {
    encoding: 'utf8',
    input: JSON.stringify({ source: 'startup' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
    // The hook bounds its fetch and merge independently. This outer guard also
    // covers a damaged script or runtime that never reaches those operations.
    timeout: 75_000,
  });
    if (stampFile && !result.error) try { fs.writeFileSync(stampFile, ''); } catch { /* optional cache */ }
  } catch (error) { result = { error }; }
  finally { release(); }

  // The hook deliberately fails open. A malformed/older hook, missing git, or
  // an offline remote must never prevent the host CLI from starting.
  let notice = null;
  let syncResult = null;
  try {
    const payload = JSON.parse(result.stdout || '{}');
    notice = payload.systemMessage || null;
    syncResult = payload.ccConfigSync || null;
  } catch {}
  return { notice, pulled: Number(syncResult?.pulled) || 0,
    repairError: syncResult?.repairError || null, skipped: false, error: result.error || null };
}
