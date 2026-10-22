#!/usr/bin/env node
// scripts/dashboard/deploy.mjs — operate the dashboard Worker (docs/dashboard.md).
// Dashboard membership lives in one place, the shared `bridge.dashboard` block of
// claude_env_settings.json: {url, botId, hosts: {machine: sha256}}. Everything the Worker
// knows is derived from it here; the only secrets (host tokens, the dashboard bot token) never
// leave the machine that owns them.
//
//   node scripts/dashboard/deploy.mjs host-token   join this host: mint its push token into this machine's
//                                                      local settings and its hash into the shared hosts
//                                                      map, then deploy (the Worker learns hosts only then)
//   node scripts/dashboard/deploy.mjs deploy       upload DASHBOARD_CONFIG and deploy to the url's domain
//                                                      (code alone also deploys from CI on push)
//   node scripts/dashboard/deploy.mjs usage-db     create the usage store (D1 `agents-usage`) if missing, bind it in
//                                                      wrangler.jsonc, apply its migrations (docs/usage.md)
//   node scripts/dashboard/deploy.mjs set-menu     point the dashboard bot's menu button at the url and
//                                                      read it back; the bot token is this machine's local
//                                                      bridge.dashboard.botToken, never synced or printed

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';
import { writePrivateFile } from '../bridge/context.mjs';
import { ENV_SETTINGS_PATH } from '../shared/config.mjs';
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
  const shared = JSON.parse(fs.readFileSync(ENV_SETTINGS_PATH, 'utf8'));
  if (!shared.bridge?.dashboard?.url) throw new Error('no shared bridge.dashboard.url: set up the dashboard first (docs/dashboard.md § Setup)');
  shared.bridge.dashboard.hosts = { ...shared.bridge.dashboard.hosts, [machine]: hash };
  fs.writeFileSync(ENV_SETTINGS_PATH, JSON.stringify(shared, null, 2) + '\n');
  writePrivateFile(LOCAL_ENV_SETTINGS_PATH, JSON.stringify(local, null, 2) + '\n');
  console.log(`${machine}: token in ${LOCAL_ENV_SETTINGS_PATH}, hash in the shared hosts`);
  deploy();
  console.log('the daemon picks the new token up within a minute');
}

export const USAGE_DB = 'agents-usage';
const WRANGLER = path.join(HERE, 'wrangler.jsonc');

function wrangler(args, opts = {}) {
  return execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'wrangler@4', ...args],
    { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

/** wrangler.jsonc with the usage store bound to `id`: the binding's one definition. */
export function bindUsageDb(jsonc, id) {
  const binding = `"d1_databases": [{ "binding": "USAGE", "database_name": "${USAGE_DB}", "database_id": "${id}", "migrations_dir": "migrations" }]`;
  return /"d1_databases":.*$/m.test(jsonc) ? jsonc.replace(/"d1_databases":.*$/m, `${binding},`)
    : jsonc.replace(/("durable_objects":.*$)/m, `$1
  // The usage store (docs/usage.md): \`npm run dashboard -- usage-db\` creates and binds it.
  ${binding},`);
}

function usageDb() {
  const find = () => JSON.parse(wrangler(['d1', 'list', '--json'])).find((d) => d.name === USAGE_DB);
  let db = find();
  if (!db) { wrangler(['d1', 'create', USAGE_DB], { stdio: 'inherit' }); db = find(); }
  if (!db?.uuid) throw new Error(`could not create or find D1 ${USAGE_DB}`);
  fs.writeFileSync(WRANGLER, bindUsageDb(fs.readFileSync(WRANGLER, 'utf8'), db.uuid));
  wrangler(['d1', 'migrations', 'apply', USAGE_DB, '--remote', '--config', WRANGLER], { stdio: 'inherit' });
  console.log(`${USAGE_DB} (${db.uuid}) bound in wrangler.jsonc and migrated; deploy to serve it`);
}

function deploy() {
  const { domain, config } = dashboardConfigFrom(readMergedEnvSettings({ sharedPath: ENV_SETTINGS_PATH })?.bridge ?? {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-deploy-'));
  const secrets = path.join(dir, 'secrets.json');
  try {
    writePrivateFile(secrets, JSON.stringify({ DASHBOARD_CONFIG: JSON.stringify(config) }));
    wrangler(['deploy', '--config', WRANGLER, '--domain', domain, '--secrets-file', secrets, '--tag', commitTag()], { stdio: 'inherit' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`deployed to https://${domain}/ (hosts: ${Object.keys(config.hosts).join(', ') || 'none'})`);
}

/** The deployed version's tag: the git commit, `+` when the tree has uncommitted changes. */
function commitTag() {
  const git = (...a) => execFileSync('git', ['-C', HERE, ...a], { encoding: 'utf8' }).trim();
  try { return `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain', '--', '.') ? '+' : ''}`; } catch { return ''; }
}

/** The dashboard bot token: machine-local layer only, like every other secret here. */
function localBotToken() {
  try { return JSON.parse(fs.readFileSync(LOCAL_ENV_SETTINGS_PATH, 'utf8')).bridge?.dashboard?.botToken ?? null; } catch { return null; }
}

/** The setChatMenuButton call for `g` (shared bridge.dashboard) with `token`; throws when they do not belong together. */
export function menuRequest(g, token) {
  if (typeof token !== 'string' || !/^\d+:[\w-]{30,}$/.test(token)) throw new Error('no bridge.dashboard.botToken in the local settings (the dashboard bot token from @BotFather)');
  if (String(g.botId) !== token.split(':')[0]) throw new Error('the local bridge.dashboard.botToken is not the bot of the shared bridge.dashboard.botId');
  if (!/^https:\/\/[^/]+$/.test(String(g.url).replace(/\/$/, ''))) throw new Error('bridge.dashboard.url must be an https origin');
  return { menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: g.url } } };
}

async function setMenu() {
  const g = readMergedEnvSettings({ sharedPath: ENV_SETTINGS_PATH })?.bridge?.dashboard ?? {};
  const token = localBotToken();
  const call = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const out = await res.json();
    if (!out.ok) throw new Error(`${method}: ${out.description}`);   // Telegram's description never echoes the token
    return out.result;
  };
  await call('setChatMenuButton', menuRequest(g, token));
  const now = await call('getChatMenuButton');
  // Telegram normalises the URL (a trailing slash), so compare what the URLs mean.
  if (!now?.web_app?.url || new URL(now.web_app.url).href !== new URL(g.url).href) throw new Error(`menu button reads back ${now?.web_app?.url ?? now?.type}, not ${g.url}`);
  console.log(`menu button "${now.text}" -> ${now.web_app.url} (read back)`);
}

export async function main([cmd] = process.argv.slice(2)) {
  if (cmd === 'host-token') return hostToken();
  if (cmd === 'deploy') return deploy();
  if (cmd === 'set-menu') return setMenu();
  if (cmd === 'usage-db') return usageDb();
  throw new Error('usage: deploy.mjs host-token | deploy | usage-db | set-menu');
}

// exitCode, not exit(): exiting with fetch sockets still open trips a libuv assertion on Windows.
if (isMain(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
