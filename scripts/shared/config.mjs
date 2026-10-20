// scripts/shared/config.mjs — two-layer provider config read (shared + machine-local).
//
// claude_env_settings.json rides the SYNC PAYLOAD (see docs/sync-architecture.md §3), not
// the repo, so every machine sees the same blocks. Machine-local values (the bridge bot token)
// live in `~/.claude/claude_env_settings.local.json`, a REAL machine-local dir (setup.js only
// junctions specific children into the repo; the directory itself is per-machine and never
// synced). This helper reads the shared file and deep-merges the local one on top (override
// wins). API keys are in neither: they live in the git credential store (docs/providers.md).
//
// The fabric plugin implements the same convention for its own consumers
// (cc-market/fabric/engine/providers.mjs `readRegistry`). Keep the two in step.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

// Machine-local secrets file, next to the linked ~/.claude/claude_env_settings.json.
export const LOCAL_ENV_SETTINGS_PATH = join(os.homedir(), '.claude', 'claude_env_settings.local.json');

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Override-wins deep merge: plain objects recurse key-by-key; every other value (scalars,
// arrays) is replaced wholesale by the override. The local file's shape mirrors the shared
// registry, so this is safe for providers.<name> blocks and the fabric block alike.
export function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * Read the provider registry with the machine-local overlay applied.
 * `sharedPath` is the synced claude_env_settings.json; `localPath` defaults to the
 * machine-local ~/.claude/claude_env_settings.local.json. Returns null when the shared
 * file is missing so callers keep their own error handling.
 */
export function readMergedEnvSettings({ sharedPath, localPath = LOCAL_ENV_SETTINGS_PATH } = {}) {
  if (!sharedPath || !existsSync(sharedPath)) return null;
  const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
  if (existsSync(localPath)) {
    return deepMerge(shared, JSON.parse(readFileSync(localPath, 'utf8')));
  }
  return shared;
}
