// scripts/setup/provider-setup.mjs — setup's provider steps: the catalogue cache.
//
// setup is the ONLY place cc-config runs Python: it asks ai-lab for its catalogue and writes
// ~/.claude/provider-cache.json (scripts/shared/provider-cache.mjs). The interpreter is the one
// passed as --ai-lab-python, else the one the previous cache recorded.

import { spawnSync } from 'child_process';
import { PROVIDER_CACHE_PATH, recordedPython, writeProviderCache } from '../shared/provider-cache.mjs';

/** Regenerate the provider cache. @returns {{ok:true, providers:number, python:string} | {error:string}} */
export function refreshProviderCache({ aiLabPython, path = PROVIDER_CACHE_PATH, run = spawnSync } = {}) {
  return writeProviderCache({ python: aiLabPython || recordedPython(path), path, run });
}
