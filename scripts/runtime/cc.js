#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';

// claude_env_settings.json contains API keys — keep permissions 0600.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envSettingsPath = join(__dirname, '..', '..', 'claude_env_settings.json');

const provider = process.argv[2] || 'claude';
const extraArgs = process.argv.slice(3);

const env = { ...process.env };
for (const key of PROVIDER_KEYS) delete env[key];

let profiles = {};
if (provider !== 'claude') {
  if (!existsSync(envSettingsPath)) {
    console.error(`Missing: ${envSettingsPath}`);
    process.exit(1);
  }
  profiles = JSON.parse(readFileSync(envSettingsPath, 'utf8'));
  const profile = profiles[`env:${provider}`];
  if (!profile) {
    const available = Object.keys(profiles).filter(k => k.startsWith('env:')).map(k => k.slice(4)).join(', ');
    console.error(`Unknown provider: ${provider}. Available: ${available}`);
    process.exit(1);
  }
  Object.assign(env, profile);
  console.log(`[cc] Using provider: ${provider}`);
} else {
  console.log('[cc] Using Claude (official subscription)');
}

const isWindows = process.platform === 'win32';

const child = spawn('claude', extraArgs, { env, stdio: 'inherit', shell: isWindows });
child.on('exit', code => process.exit(code ?? 0));
