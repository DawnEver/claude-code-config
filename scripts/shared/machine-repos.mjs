// scripts/shared/machine-repos.mjs -- this machine's checkouts, as its machine file's [repos] table declares
// them (`<name> = "<path>"`), read through lab_commons under cc-config's own interpreter (own-python.mjs) --
// never a second TOML reader, never a path guessed beside this repo. market-dir.mjs derives from it.

import { spawnSync } from 'child_process';
import { ownPython } from './own-python.mjs';

/** lab_commons' reader of the machine file's [repos] table, printed as {name: path}. */
export const REPOS_DOOR = ['-c',
  'import json; from lab_commons.home import repos; print(json.dumps({k: str(v) for k, v in repos().items()}))'];

/**
 * The machine file's [repos], read once.
 * @returns {{repos: Record<string, string> | null, why: string | null}}
 */
export function readMachineRepos({ python = ownPython(), run = spawnSync } = {}) {
  const none = (why) => ({ repos: null, why });
  const res = run(python, REPOS_DOOR, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (res.error) return none(`door failed: ${res.error.message} (build it: node scripts/setup/setup.js)`);
  if (res.status !== 0) return none(`door failed: ${String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`}`);
  let doc;
  try { doc = JSON.parse(res.stdout); } catch { return none('door printed no JSON'); }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? { repos: doc, why: null } : none('door printed no {name: path} object');
}
