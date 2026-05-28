#!/usr/bin/env node
/**
 * Configure VS Code user settings for a Claude Code provider.
 *
 * Usage:
 *   node scripts/setup/setup-vscode.js [provider]
 *
 * Examples:
 *   node scripts/setup/setup-vscode.js deepseek
 *   node scripts/setup/setup-vscode.js claude      # revert to official
 *
 * What it does:
 *   - Sets terminal.integrated.env.* so the "Open in Terminal" button
 *     launches claude with the provider's env vars.
 *   - On macOS/Linux: also sets claudeCode.claudeProcessWrapper so the
 *     chat panel uses the provider wrapper (Windows .cmd cannot be spawned
 *     directly by the extension).
 *   - When provider is "claude" (or omitted): clears both settings.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, '../..');
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

const PROVIDER_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
];

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

  if (settings['claudeCode.claudeProcessWrapper']) {
    delete settings['claudeCode.claudeProcessWrapper'];
    delete settings['claudeCode.disableLoginPrompt'];
    console.log('WRITE claudeCode.claudeProcessWrapper — removed');
    changed = true;
  } else {
    console.log('OK    claudeCode.claudeProcessWrapper — not set');
  }
} else {
  // Apply provider
  const envSettingsPath = path.join(sourceDir, 'claude_env_settings.json');
  if (!fs.existsSync(envSettingsPath)) {
    console.error(`ERROR Missing: ${envSettingsPath}`);
    process.exit(1);
  }

  let profiles;
  try { profiles = JSON.parse(fs.readFileSync(envSettingsPath, 'utf8')); } catch {
    console.error('ERROR Could not parse claude_env_settings.json');
    process.exit(1);
  }

  const profile = profiles[`env:${provider}`];
  if (!profile) {
    const available = Object.keys(profiles)
      .filter(k => k.startsWith('env:') && k !== 'env:claude')
      .map(k => k.replace('env:', ''));
    console.error(`ERROR Unknown provider: ${provider}`);
    console.error(`      Available: ${available.join(', ')}`);
    process.exit(1);
  }

  if (!Object.keys(profile).length) {
    console.error(`ERROR Provider "${provider}" has no env vars configured in claude_env_settings.json`);
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

  // claudeCode.claudeProcessWrapper: only on macOS/Linux (Windows .cmd fails spawn EINVAL)
  if (!isWindows) {
    let claudeBin;
    try {
      claudeBin = path.dirname(
        execSync('which claude', { stdio: 'pipe' }).toString().trim()
      );
    } catch {
      claudeBin = null;
    }

    if (claudeBin) {
      const wrapperPath = path.join(claudeBin, provider === 'deepseek' ? 'ccds' : provider);
      if (fs.existsSync(wrapperPath)) {
        if (settings['claudeCode.claudeProcessWrapper'] !== wrapperPath) {
          settings['claudeCode.claudeProcessWrapper'] = wrapperPath;
          settings['claudeCode.disableLoginPrompt'] = true;
          console.log(`WRITE claudeCode.claudeProcessWrapper = "${wrapperPath}"`);
          changed = true;
        } else {
          console.log('OK    claudeCode.claudeProcessWrapper — already up to date');
        }
      } else {
        console.log(`SKIP  claudeCode.claudeProcessWrapper — wrapper not found at ${wrapperPath}`);
      }
    } else {
      console.log('SKIP  claudeCode.claudeProcessWrapper — could not locate claude executable');
    }
  } else {
    console.log('SKIP  claudeCode.claudeProcessWrapper — not supported on Windows (.cmd cannot be spawned by extension)');
  }
}

if (changed) {
  fs.writeFileSync(vscodeSettingsPath, JSON.stringify(settings, null, 2));
  console.log('\nDone. Restart terminal for changes to take effect.');
} else {
  console.log('\nDone. No changes needed.');
}
