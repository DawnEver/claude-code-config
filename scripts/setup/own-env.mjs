// scripts/setup/own-env.mjs -- setup's first Python step: build this checkout's own environment (.venv) from
// its lock, so every door (own-python.mjs) runs the versions uv.lock pins. Frozen: setup never relocks.

import { spawnSync } from 'child_process';
import { OWN_ROOT } from '../shared/own-python.mjs';

/** `uv sync --frozen` for this checkout. @returns {{ok: true} | {error: string}} */
export function buildOwnEnv({ root = OWN_ROOT, run = spawnSync } = {}) {
  const args = ['sync', '--frozen', '--project', root];
  const res = run('uv', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (res.error?.code === 'ENOENT') return { error: 'uv is not installed (https://docs.astral.sh/uv/); cc-config builds its own environment with it' };
  if (res.error) return { error: `uv sync failed: ${res.error.message}` };
  if (res.status !== 0) return { error: `uv ${args.join(' ')} failed: ${String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`}` };
  return { ok: true };
}
