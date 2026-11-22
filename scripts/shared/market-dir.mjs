// scripts/shared/market-dir.mjs -- where this machine's cc-market checkout lives: the machine file's
// [repos] cc-market (machine-repos.mjs). Undeclared is no location plus why, naming the door.

import { readMachineRepos } from './machine-repos.mjs';

/** Where a missing declaration is fixed. */
export const MARKET_FIX = 'declare it: python -m dev_lab.dev.devhost local set repos.cc-market <path of the cc-market checkout>';

/**
 * This machine's cc-market checkout, read once.
 * @returns {{dir: string | null, why: string | null}}
 */
export function readMarketDir({ read = readMachineRepos } = {}) {
  const none = (why) => ({ dir: null, why: `cc-market checkout unknown: ${why}; ${MARKET_FIX}` });
  const { repos, why } = read();
  if (!repos) return none(why);
  const dir = repos['cc-market'];
  return typeof dir === 'string' && dir ? { dir, why: null } : none('cc-market is not declared in the machine file [repos]');
}
