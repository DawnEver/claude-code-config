// scripts/setup/provider-setup.mjs — setup's provider steps: the catalogue cache and the
// one-shot move of plaintext keys into the git credential store.
//
// setup is the ONLY place cc-config runs Python: it asks ai-lab for its catalogue and writes
// ~/.claude/provider-cache.json (scripts/shared/provider-cache.mjs). The interpreter is the one
// passed as --ai-lab-python, else the one the previous cache recorded.

import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { PROVIDER_CACHE_PATH, recordedPython, writeProviderCache } from '../shared/provider-cache.mjs';

/** Regenerate the provider cache. @returns {{ok:true, providers:number, python:string} | {error:string}} */
export function refreshProviderCache({ aiLabPython, path = PROVIDER_CACHE_PATH, run = spawnSync } = {}) {
  return writeProviderCache({ python: aiLabPython || recordedPython(path), path, run });
}

/** The first free `<file>.setup-bak[.N]`: a backup never overwrites an earlier one. */
function freeBackupPath(file) {
  for (let n = 1; ; n++) {
    const candidate = `${file}.setup-bak${n === 1 ? '' : `.${n}`}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * One-shot: move each plaintext `providers.<p>.apiKey` of the machine-local settings file into the
 * git credential store as the `session` task key, via ai-lab (`login <p> --task session`, the key on
 * stdin, never argv; ai-lab's duplicate-key refusal applies). The file is backed up once, then each
 * STORED field is deleted; a refused one stays, and the launcher refuses it by name until resolved.
 * A key never appears in a message: a failure names the provider and ai-lab's last stderr line.
 *
 * @returns {{status: 'no-file'|'none'|'malformed'|'migrated'|'failed', stored?: string[],
 *   failed?: {provider: string, why: string}[], backupPath?: string, error?: string}}
 */
export function migrateApiKeysToStore({ localPath, python, run = spawnSync }) {
  if (!existsSync(localPath)) return { status: 'no-file' };
  let parsed;
  try { parsed = JSON.parse(readFileSync(localPath, 'utf8')); } catch (e) { return { status: 'malformed', error: e.message }; }
  const keyed = Object.entries(parsed.providers || {}).filter(([, b]) => typeof b?.apiKey === 'string' && b.apiKey);
  if (!keyed.length) return { status: 'none' };
  if (!python) {
    return { status: 'failed', stored: [], failed: keyed.map(([provider]) => ({ provider, why: 'no Python for ai-lab (pass --ai-lab-python)' })) };
  }

  const stored = [];
  const failed = [];
  for (const [provider, block] of keyed) {
    const res = run(python, ['-m', 'ai_lab.auth', 'login', provider, '--task', 'session'],
      { input: `${block.apiKey}\n`, encoding: 'utf8', windowsHide: true });
    if (res.error?.code === 'ENOENT') failed.push({ provider, why: `no Python: ${python} not found` });
    else if (res.error || res.status !== 0) {
      failed.push({ provider, why: String(res.stderr || res.error?.message || `exit ${res.status}`).trim().split('\n').pop() });
    } else stored.push(provider);
  }
  if (!stored.length) return { status: 'failed', stored, failed };

  const backupPath = freeBackupPath(localPath);
  copyFileSync(localPath, backupPath);
  for (const provider of stored) {
    delete parsed.providers[provider].apiKey;
    if (!Object.keys(parsed.providers[provider]).length) delete parsed.providers[provider];
  }
  if (!Object.keys(parsed.providers).length) delete parsed.providers;
  writeFileSync(localPath, JSON.stringify(parsed, null, 2) + '\n');
  return { status: failed.length ? 'failed' : 'migrated', stored, failed, backupPath };
}
