import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
} = {}) {
  if (env.CC_CONFIG_STARTUP_SYNCED === '1') return { notice: null, skipped: true };

  const result = spawn(nodePath, [hookPath, '--pull'], {
    encoding: 'utf8',
    input: JSON.stringify({ source: 'startup' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env,
    // The hook bounds its fetch and merge independently. This outer guard also
    // covers a damaged script or runtime that never reaches those operations.
    timeout: 75_000,
  });

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
