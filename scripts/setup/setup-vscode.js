#!/usr/bin/env node
/**
 * Configure VS Code user settings for a Claude Code provider.
 *
 * Usage:
 *   node scripts/setup/setup-vscode.js [provider]
 *
 * Examples:
 *   node scripts/setup/setup-vscode.js deepseek
 *   node scripts/setup/setup-vscode.js kimi
 *   node scripts/setup/setup-vscode.js claude      # revert to official
 *
 * What it does:
 *   - Sets terminal.integrated.env.* so the "Open in Terminal" button
 *     launches claude with the provider's env vars.
 *   - Sets claudeCode.environmentVariables so the chat panel uses the
 *     provider's env vars (cross-platform, replaces legacy
 *     claudeCode.claudeProcessWrapper which only worked on macOS/Linux
 *     and required a native binary).
 *   - When provider is "claude" (or omitted): clears all provider settings.
 */

import fs from 'fs';
import path from 'path';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { buildClaudeInvocation } from '../runtime/cc-launcher.mjs';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveSyncDir } from '../shared/sync-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, '../..');
const getSyncDir = () => resolveSyncDir({ repoRoot: sourceDir });
const isWindows = process.platform === 'win32';

const provider = process.argv[2] || 'claude';

const vscodeSettingsPath = isWindows
  ? path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    : path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json');

if (!fs.existsSync(vscodeSettingsPath)) {
  console.error('ERROR VS Code user settings not found — is VS Code installed?');
  console.error(`      Expected: ${vscodeSettingsPath}`);
  process.exit(1);
}

let settings;
try {
  settings = JSON.parse(fs.readFileSync(vscodeSettingsPath, 'utf8'));
} catch {
  console.error('ERROR Could not parse VS Code settings.json');
  process.exit(1);
}

const termEnvKey = isWindows
  ? 'terminal.integrated.env.windows'
  : process.platform === 'darwin'
    ? 'terminal.integrated.env.osx'
    : 'terminal.integrated.env.linux';

let changed = false;

if (provider === 'claude') {
  // Revert: clear provider env vars from terminal env and remove wrapper
  const termEnv = settings[termEnvKey] || {};
  const cleaned = Object.fromEntries(
    Object.entries(termEnv).filter(([k]) => !PROVIDER_KEYS.includes(k))
  );
  if (JSON.stringify(cleaned) !== JSON.stringify(termEnv)) {
    if (Object.keys(cleaned).length === 0) delete settings[termEnvKey];
    else settings[termEnvKey] = cleaned;
    console.log(`WRITE ${termEnvKey} — removed provider env vars`);
    changed = true;
  } else {
    console.log(`OK    ${termEnvKey} — no provider env vars to remove`);
  }

  if (settings['claudeCode.environmentVariables']?.length) {
    settings['claudeCode.environmentVariables'] = [];
    delete settings['claudeCode.disableLoginPrompt'];
    console.log('WRITE claudeCode.environmentVariables — cleared');
    changed = true;
  } else {
    console.log('OK    claudeCode.environmentVariables — already empty');
  }

  if (settings['claudeCode.claudeProcessWrapper']) {
    delete settings['claudeCode.claudeProcessWrapper'];
    console.log('WRITE claudeCode.claudeProcessWrapper — removed (legacy)');
    changed = true;
  }
} else {
  // Apply provider
  // The payload may live outside the repo; resolve it the same way setup does.
  const envSettingsPath = path.join(getSyncDir(), 'claude_env_settings.json');

  // Project the provider through the launcher's own builder rather than reading
  // claude_env_settings.json here. This used to look up `env:<provider>` — a schema
  // retired on 2026-08-25 when the registry moved to `providers.<name>` — so every
  // call with a non-claude provider failed with "Unknown provider" and an empty
  // available list. Reusing buildClaudeInvocation also means VS Code, `ccc` and
  // `cods` cannot drift: one projection, one source of truth.
  const { env: projected, error } = buildClaudeInvocation({ provider, envSettingsPath });
  if (error) {
    console.error(`ERROR ${error}`);
    process.exit(1);
  }
  const profile = Object.fromEntries(
    Object.entries(projected).filter(([k]) => PROVIDER_KEYS.includes(k))
  );
  if (!Object.keys(profile).length) {
    console.error(`ERROR Provider "${provider}" projects no env vars — check its ` +
      `url/models block in claude_env_settings.json`);
    process.exit(1);
  }

  // Inject into terminal env (strip old provider keys first, then apply new ones)
  const termEnv = Object.fromEntries(
    Object.entries(settings[termEnvKey] || {}).filter(([k]) => !PROVIDER_KEYS.includes(k))
  );
  const merged = { ...termEnv, ...profile };
  if (JSON.stringify(merged) !== JSON.stringify(settings[termEnvKey] || {})) {
    settings[termEnvKey] = merged;
    console.log(`WRITE ${termEnvKey} — set ${Object.keys(profile).length} env vars for ${provider}`);
    changed = true;
  } else {
    console.log(`OK    ${termEnvKey} — already up to date`);
  }

  // Set claudeCode.environmentVariables for the VS Code chat panel extension
  const envVarList = Object.entries(profile)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(envVarList) !== JSON.stringify(settings['claudeCode.environmentVariables'] || [])) {
    settings['claudeCode.environmentVariables'] = envVarList;
    settings['claudeCode.disableLoginPrompt'] = true;
    console.log(`WRITE claudeCode.environmentVariables — set ${envVarList.length} env vars for ${provider}`);
    changed = true;
  } else {
    console.log(`OK    claudeCode.environmentVariables — already up to date`);
  }

  // Clean up legacy claudeProcessWrapper if still set from a previous version
  if (settings['claudeCode.claudeProcessWrapper']) {
    delete settings['claudeCode.claudeProcessWrapper'];
    console.log('WRITE claudeCode.claudeProcessWrapper — removed (legacy)');
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(vscodeSettingsPath, JSON.stringify(settings, null, 2));
  console.log('\nDone. Restart terminal for changes to take effect.');
} else {
  console.log('\nDone. No changes needed.');
}
