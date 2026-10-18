#!/usr/bin/env node
// scripts/fleet-gateway/deploy.mjs — operate the fleet gateway Worker (docs/fleet-gateway.md).
// Fleet membership lives in one place, the shared `bridge.fleetGateway` block of
// claude_env_settings.json: {url, botId, hosts: {machine: sha256}}. Everything the Worker
// knows is derived from it here; the only secrets (host tokens, the fleet bot token) never
// leave the machine that owns them.
//
//   node scripts/fleet-gateway/deploy.mjs host-token   mint this host's push token: the token goes
//                                                      into this machine's local settings, the
//                                                      printed hash into the shared hosts map
//   node scripts/fleet-gateway/deploy.mjs deploy       upload FLEET_CONFIG and deploy to the url's domain
//   FLEET_BOT_TOKEN=... node scripts/fleet-gateway/deploy.mjs set-menu
//                                                      point the fleet bot's menu button at the url
//                                                      (token read from the environment, never stored)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';
import { SHARED_ENV_SETTINGS_PATH, writePrivateFile } from '../bridge/context.mjs';
import { newHostToken } from './auth.mjs';
import { parseFleetConfig } from './api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The Worker's FLEET_CONFIG from the merged bridge config; throws on anything it cannot serve. */
export function fleetConfigFrom(bridge) {
  const g = bridge.fleetGateway ?? {};
  const url = new URL(g.url ?? 'missing:');
  if (url.protocol !== 'https:' || url.pathname !== '/') throw new Error('bridge.fleetGateway.url must be an https origin');
  const config = { botId: g.botId, allowedUserIds: bridge.allowedUserIds ?? [], hosts: g.hosts ?? {} };
  parseFleetConfig(config);
  if (!config.allowedUserIds.length) throw new Error('bridge.allowedUserIds is empty: nobody could open the fleet');
  return { domain: url.hostname, config };
}

async function hostToken() {
  const machine = readMachineName();
  if (!machine) throw new Error('no machine name: run setup.js --machine <NAME>');
  const { token, hash } = await newHostToken();
  const local = fs.existsSync(LOCAL_ENV_SETTINGS_PATH) ? JSON.parse(fs.readFileSync(LOCAL_ENV_SETTINGS_PATH, 'utf8')) : {};
  local.bridge ??= {};
  local.bridge.fleetGateway = { ...local.bridge.fleetGateway, hostToken: token };
  writePrivateFile(LOCAL_ENV_SETTINGS_PATH, JSON.stringify(local, null, 2) + '\n');
  console.log(`token written to ${LOCAL_ENV_SETTINGS_PATH}`);
  console.log(`add to the shared claude_env_settings.json, bridge.fleetGateway.hosts:\n  "${machine}": "${hash}"`);
  console.log('then run deploy, and restart this daemon (the next session start does it)');
}

function deploy() {
  const { domain, config } = fleetConfigFrom(readMergedEnvSettings({ sharedPath: SHARED_ENV_SETTINGS_PATH })?.bridge ?? {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-deploy-'));
  const secrets = path.join(dir, 'secrets.json');
  try {
    writePrivateFile(secrets, JSON.stringify({ FLEET_CONFIG: JSON.stringify(config) }));
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['-y', 'wrangler@4', 'deploy', '--config', path.join(HERE, 'wrangler.jsonc'), '--domain', domain, '--secrets-file', secrets],
      { stdio: 'inherit', shell: process.platform === 'win32' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`deployed to https://${domain}/ (hosts: ${Object.keys(config.hosts).join(', ') || 'none'})`);
}

async function setMenu() {
  const g = readMergedEnvSettings({ sharedPath: SHARED_ENV_SETTINGS_PATH })?.bridge?.fleetGateway ?? {};
  const token = process.env.FLEET_BOT_TOKEN;
  if (!token) throw new Error('set FLEET_BOT_TOKEN to the fleet bot token (from @BotFather) for this one call');
  if (String(g.botId) !== token.split(':')[0]) throw new Error('FLEET_BOT_TOKEN is not the bot of bridge.fleetGateway.botId');
  const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Fleet', web_app: { url: g.url } } }) });
  const body = await res.json();
  if (!body.ok) throw new Error(`setChatMenuButton: ${body.description}`);
  console.log(`menu button -> ${g.url}`);
}

export async function main([cmd] = process.argv.slice(2)) {
  if (cmd === 'host-token') return hostToken();
  if (cmd === 'deploy') return deploy();
  if (cmd === 'set-menu') return setMenu();
  throw new Error('usage: deploy.mjs host-token | deploy | set-menu');
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
