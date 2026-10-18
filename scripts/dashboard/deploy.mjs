#!/usr/bin/env node
// scripts/dashboard/deploy.mjs — operate the dashboard Worker (docs/dashboard.md).
// Dashboard membership lives in one place, the shared `bridge.dashboard` block of
// claude_env_settings.json: {url, botId, hosts: {machine: sha256}}. Everything the Worker
// knows is derived from it here; the only secrets (host tokens, the dashboard bot token) never
// leave the machine that owns them.
//
//   node scripts/dashboard/deploy.mjs host-token   mint this host's push token: the token goes
//                                                      into this machine's local settings, the
//                                                      printed hash into the shared hosts map
//   node scripts/dashboard/deploy.mjs deploy       upload DASHBOARD_CONFIG and deploy to the url's domain
//   DASHBOARD_BOT_TOKEN=... node scripts/dashboard/deploy.mjs set-menu
//                                                      point the dashboard bot's menu button at the url
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
import { parseDashboardConfig } from './api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The Worker's DASHBOARD_CONFIG from the merged bridge config; throws on anything it cannot serve. */
export function dashboardConfigFrom(bridge) {
  const g = bridge.dashboard ?? {};
  const url = new URL(g.url ?? 'missing:');
  if (url.protocol !== 'https:' || url.pathname !== '/') throw new Error('bridge.dashboard.url must be an https origin');
  const config = { botId: g.botId, allowedUserIds: bridge.allowedUserIds ?? [], hosts: g.hosts ?? {} };
  parseDashboardConfig(config);
  if (!config.allowedUserIds.length) throw new Error('bridge.allowedUserIds is empty: nobody could open the dashboard');
  return { domain: url.hostname, config };
}

async function hostToken() {
  const machine = readMachineName();
  if (!machine) throw new Error('no machine name: run setup.js --machine <NAME>');
  const { token, hash } = await newHostToken();
  const local = fs.existsSync(LOCAL_ENV_SETTINGS_PATH) ? JSON.parse(fs.readFileSync(LOCAL_ENV_SETTINGS_PATH, 'utf8')) : {};
  local.bridge ??= {};
  local.bridge.dashboard = { ...local.bridge.dashboard, hostToken: token };
  writePrivateFile(LOCAL_ENV_SETTINGS_PATH, JSON.stringify(local, null, 2) + '\n');
  console.log(`token written to ${LOCAL_ENV_SETTINGS_PATH}`);
  console.log(`add to the shared claude_env_settings.json, bridge.dashboard.hosts:\n  "${machine}": "${hash}"`);
  console.log('then run deploy, and restart this daemon (the next session start does it)');
}

function deploy() {
  const { domain, config } = dashboardConfigFrom(readMergedEnvSettings({ sharedPath: SHARED_ENV_SETTINGS_PATH })?.bridge ?? {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-deploy-'));
  const secrets = path.join(dir, 'secrets.json');
  try {
    writePrivateFile(secrets, JSON.stringify({ DASHBOARD_CONFIG: JSON.stringify(config) }));
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['-y', 'wrangler@4', 'deploy', '--config', path.join(HERE, 'wrangler.jsonc'), '--domain', domain, '--secrets-file', secrets],
      { stdio: 'inherit', shell: process.platform === 'win32' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`deployed to https://${domain}/ (hosts: ${Object.keys(config.hosts).join(', ') || 'none'})`);
}

async function setMenu() {
  const g = readMergedEnvSettings({ sharedPath: SHARED_ENV_SETTINGS_PATH })?.bridge?.dashboard ?? {};
  const token = process.env.DASHBOARD_BOT_TOKEN;
  if (!token) throw new Error('set DASHBOARD_BOT_TOKEN to the dashboard bot token (from @BotFather) for this one call');
  if (String(g.botId) !== token.split(':')[0]) throw new Error('DASHBOARD_BOT_TOKEN is not the bot of bridge.dashboard.botId');
  const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: g.url } } }) });
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
