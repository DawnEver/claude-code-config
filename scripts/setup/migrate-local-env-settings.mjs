// scripts/setup/migrate-local-env-settings.mjs — one-shot migration of
// `~/.claude/claude_env_settings.local.json` from the pre-2026-08-25
// `env:<provider>` shape to the new `providers.<provider>.apiKey` shape.
//
// Pre-refactor local file:
//   { "env:deepseek": { "ANTHROPIC_API_KEY": "sk-..." },
//     "env:kimi":    { "ANTHROPIC_API_KEY": "sk-..." },
//     "env:gmi":     { "ANTHROPIC_AUTH_TOKEN": "..." } }
//
// Post-refactor local file:
//   { "providers": { "deepseek": { "apiKey": "sk-..." },
//                    "kimi":    { "apiKey": "sk-..." },
//                    "gmi":     { "apiKey": "..." } } }
//
// The local file's `env:<provider>` block only ever held a single string value
// (the API key) — the rest of the per-provider env vars lived in the shared
// `claude_env_settings.json` and are now declared as the new schema's
// `claudeApiKeyEnv` / `claudeModel` / etc. Migration extracts the first string
// value from each legacy block and writes it as the new `apiKey`.
//
// The destructive write is preceded by a `.setup-bak` copy (same convention as
// `linkEntry()`), so a OneDrive sync-down that breaks the file or a wrong
// conversion is recoverable.

import fs from 'fs';

/**
 * Migrate a local env-settings file in-place from the legacy `env:<provider>`
 * shape to `providers.<provider>.apiKey`.
 *
 * @param {object} opts
 * @param {string} opts.localPath  Absolute path to the local settings file.
 * @returns {{
 *   status: 'no-file' | 'malformed' | 'current' | 'mixed' | 'migrated',
 *   providers?: string[],
 *   backupPath?: string,
 *   note?: string,
 *   error?: string,
 * }}
 */
export function migrateLocalEnvSettings({ localPath }) {
  if (!fs.existsSync(localPath)) {
    return { status: 'no-file' };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  } catch (err) {
    return { status: 'malformed', error: err.message };
  }

  const topKeys = Object.keys(parsed);
  const hasLegacy = topKeys.some(k => k.startsWith('env:'));
  const providers = parsed.providers;
  const hasNew = providers && typeof providers === 'object'
    && Object.keys(providers).length > 0;

  if (!hasLegacy) {
    return { status: 'current', note: hasNew ? 'already in new shape' : 'empty local file' };
  }
  if (hasNew) {
    return {
      status: 'mixed',
      note: 'both env: and providers: blocks present — leaving alone',
      legacyKeys: topKeys.filter(k => k.startsWith('env:')),
      newKeys: Object.keys(providers),
    };
  }

  // Build the migrated shape. Preserve non-env:* top-level keys verbatim
  // (fabric overrides, etc.); for each env:<name> block, take the first
  // string value as the new apiKey.
  const migrated = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith('env:')) {
      migrated[k] = v;
      continue;
    }
    const name = k.slice('env:'.length);
    if (!migrated.providers) migrated.providers = {};
    if (migrated.providers[name]) continue; // first value wins on duplicates
    const stringValues = Object.values(v || {}).filter(x => typeof x === 'string');
    if (stringValues.length === 0) continue; // no usable value — skip
    migrated.providers[name] = { apiKey: stringValues[0] };
  }

  const backupPath = localPath + '.setup-bak';
  fs.copyFileSync(localPath, backupPath);
  fs.writeFileSync(localPath, JSON.stringify(migrated, null, 2) + '\n');

  return {
    status: 'migrated',
    providers: Object.keys(migrated.providers || {}),
    backupPath,
  };
}
