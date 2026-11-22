// scripts/shared/machine-repos.mjs -- this machine's checkouts, as its machine file's [repos] table declares
// them (`<name> = "<path>"`), read through lab_commons (never a second TOML reader, never a path guessed
// beside this repo). What derives from it: the cc-market checkout (market-dir.mjs) and the interpreter that
// runs dev-lab's doors (devLabPython), the dev-lab checkout's own environment -- the same one dev-lab renders
// for the bridge (dev_lab.dev.devprofile.bridge_python).

import path from 'path';
import { spawnSync } from 'child_process';
import { recordedPython } from './provider-cache.mjs';

/** lab_commons' reader of the machine file's [repos] table, printed as {name: path}. */
export const REPOS_DOOR = ['-c',
  'import json; from lab_commons.home import repos; print(json.dumps({k: str(v) for k, v in repos().items()}))'];
/** Where a missing dev-lab checkout is declared. */
export const DEV_LAB_FIX = 'declare it: python -m dev_lab.dev.devhost local set repos.dev-lab <path of the dev-lab main checkout>';

/**
 * The machine file's [repos], read once through the recorded interpreter (it carries lab_commons).
 * @returns {{repos: Record<string, string> | null, why: string | null}}
 */
export function readMachineRepos({ python = recordedPython(), run = spawnSync } = {}) {
  const none = (why) => ({ repos: null, why });
  if (!python) return none('no recorded python (run node scripts/setup/setup.js)');
  const res = run(python, REPOS_DOOR, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (res.error) return none(`door failed: ${res.error.message}`);
  if (res.status !== 0) return none(`door failed: ${String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`}`);
  let doc;
  try { doc = JSON.parse(res.stdout); } catch { return none('door printed no JSON'); }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? { repos: doc, why: null } : none('door printed no {name: path} object');
}

/**
 * The interpreter that runs dev-lab's doors: the declared dev-lab checkout's .venv, in the platform's layout.
 * @returns {{python: string | null, why: string | null}}
 */
export function devLabPython({ read = readMachineRepos, platform = process.platform } = {}) {
  const { repos, why } = read();
  if (!repos) return { python: null, why };
  const checkout = repos['dev-lab'];
  if (typeof checkout !== 'string' || !checkout) return { python: null, why: `dev-lab is not declared in the machine file [repos]; ${DEV_LAB_FIX}` };
  const layout = platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];
  return { python: path.posix.join(checkout.replace(/\\/g, '/'), ...layout), why: null };
}
