// scripts/shared/market-dir.mjs -- where this machine's cc-market checkout lives. Its one source is the
// machine file's [repos] table (`cc-market = "<path>"`), read through lab_commons (never a second TOML
// reader, never a path guessed beside this repo). Undeclared is no location plus why, naming the door.

import { spawnSync } from 'child_process';
import { recordedPython } from './provider-cache.mjs';

/** lab_commons' reader of the machine file's [repos] table, printed as {name: path}. */
export const MARKET_DOOR = ['-c',
  'import json; from lab_commons.home import repos; print(json.dumps({k: str(v) for k, v in repos().items()}))'];
/** Where a missing declaration is fixed. */
export const MARKET_FIX = 'declare it: python -m dev_lab.dev.devhost local set repos.cc-market <path of the cc-market checkout>';

/**
 * This machine's cc-market checkout, read once.
 * @returns {{dir: string | null, why: string | null}}
 */
export function readMarketDir({ python = recordedPython(), run = spawnSync } = {}) {
  const none = (why) => ({ dir: null, why: `cc-market checkout unknown: ${why}; ${MARKET_FIX}` });
  if (!python) return none('no recorded python (run node scripts/setup/setup.js)');
  const res = run(python, MARKET_DOOR, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (res.error) return none(`door failed: ${res.error.message}`);
  if (res.status !== 0) return none(`door failed: ${String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`}`);
  let doc;
  try { doc = JSON.parse(res.stdout); } catch { return none('door printed no JSON'); }
  const dir = doc?.['cc-market'];
  return typeof dir === 'string' && dir ? { dir, why: null } : none('cc-market is not declared in the machine file [repos]');
}
