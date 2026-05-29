#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envSettingsPath = join(__dirname, '..', '..', 'claude_env_settings.json');

const PROVIDER_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
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
  console.log('[cc] Using Claude Pro (official subscription)');
}

const isWindows = process.platform === 'win32';

// Auto-start proxy for providers that need it (deepseek, gpt)
const PROXY_PROVIDERS = new Set(['deepseek']);
if (PROXY_PROVIDERS.has(provider)) {
  const port = profiles.proxy?.port || 3082;
  await ensureProxy(__dirname, port);
}

const child = spawn('claude', extraArgs, { env, stdio: 'inherit', shell: isWindows });
child.on('exit', code => process.exit(code ?? 0));

function isProxyHealthy(port) {
  return new Promise(resolve => {
    const tcp = net.createConnection(port, '127.0.0.1');
    tcp.once('connect', () => {
      tcp.destroy();
      // TCP up — confirm HTTP /health responds (rules out hung proxy)
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, res => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    tcp.once('error', () => resolve(false));
  });
}

async function ensureProxy(dir, port) {
  if (await isProxyHealthy(port)) return;

  const proxyPath = join(dir, 'api-proxy.js');
  const proc = spawn(process.execPath, [proxyPath], {
    detached: true, stdio: 'ignore',
    env: { ...process.env },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await isProxyHealthy(port)) { console.log(`[cc] Proxy started on :${port}`); return; }
  }
  console.error(`[cc] Proxy failed to start on :${port} — cannot proceed`);
  process.exit(1);
}
