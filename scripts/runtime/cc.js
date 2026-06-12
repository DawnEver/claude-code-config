#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envSettingsPath = join(__dirname, '..', '..', 'claude_env_settings.json');

const PROVIDER_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
];

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
