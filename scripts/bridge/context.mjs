// scripts/bridge/context.mjs — what the bridge needs to know about this machine and a
// session's working tree. Everything is read through ~/.claude links, never a machine path
// (docs/sync-architecture.md §2): bridge config is the `bridge` block of the shared
// claude_env_settings.json with the machine-local claude_env_settings.local.json merged on
// top, and secrets (bot token, allowlist) exist only in the local layer.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'child_process';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const SHARED_ENV_SETTINGS_PATH = path.join(CLAUDE_DIR, 'claude_env_settings.json');
/** Machine-local runtime dir: daemon port + IPC token + Telegram caches. Never synced. */
export const BRIDGE_RUNTIME_DIR = path.join(CLAUDE_DIR, 'bridge');
export const RUNTIME_FILE = path.join(BRIDGE_RUNTIME_DIR, 'runtime.json');

/** Fingerprint of the normalised bridge config: a daemon read at startup is stale once it changes. */
export function bridgeConfigRevision(config = readBridgeConfig()) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

/** Source-only daemon fingerprint; not config, host binary or channel process identity. */
export function bridgeSourceRevision(repoRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  const hash = createHash('sha256');
  for (const dir of ['scripts/bridge', 'scripts/shared']) {
    for (const name of fs.readdirSync(path.join(repoRoot, dir)).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort()) {
      hash.update(`${dir}/${name}\0`);
      hash.update(fs.readFileSync(path.join(repoRoot, dir, name)));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

/**
 * The single source for the bridge's tunable defaults (0 = never for both).
 * codexSources: the Codex SessionSource kinds bridged as main sessions — a string source
 * (`cli`, `vscode`, `exec`, `appServer`, `unknown`) or an object source's key (`custom`,
 * `subAgent`).
 */
export const BRIDGE_DEFAULTS = { idleCloseMinutes: 30, deleteClosedAfterHours: 24, codexSources: ['cli'] };

const nonNegative = (v, dflt) => (typeof v === 'number' && v >= 0 ? v : dflt);

/**
 * Normalised bridge config.
 * shared:  bridge.projects.<repo>.{chatId, projectInTitle?: 'always'|'main'|'never'}, bridge.fallbackChatId,
 *          bridge.idleCloseMinutes, bridge.deleteClosedAfterHours, bridge.codexSources,
 *          bridge.fleet.{chatId, topicId?, everyMinutes?, timeFormat?, order?, always?} (the fleet
 *          report; off without chatId. Its seats are the top-level `seats`, scripts/shared/seats.mjs)
 *          bridge.fleetGateway.{url, everySeconds?} (push to the fleet gateway; off without url + hostToken)
 * local:   bridge.botToken, bridge.allowedUserIds, bridge.approvalsFromTelegram, bridge.fleetGateway.hostToken
 * Either layer may set any key; local wins — except fleetGateway.hostToken, local only.
 */
export function readBridgeConfig({ sharedPath = SHARED_ENV_SETTINGS_PATH, localPath = LOCAL_ENV_SETTINGS_PATH } = {}) {
  const merged = readMergedEnvSettings({ sharedPath, localPath }) ?? {};
  const b = merged.bridge ?? {};
  const projects = {};
  for (const [name, p] of Object.entries(b.projects ?? {})) if (p?.chatId) projects[name] = { chatId: p.chatId,
    projectInTitle: ['main', 'never'].includes(p.projectInTitle) ? p.projectInTitle : 'always' };
  return {
    botToken: typeof b.botToken === 'string' && !/your-|^$/.test(b.botToken) ? b.botToken : null,
    allowedUserIds: (b.allowedUserIds ?? []).map(Number).filter(Number.isFinite),
    approvalsFromTelegram: b.approvalsFromTelegram === true,
    fallbackChatId: b.fallbackChatId ?? null,
    idleCloseMinutes: nonNegative(b.idleCloseMinutes, BRIDGE_DEFAULTS.idleCloseMinutes),
    deleteClosedAfterHours: nonNegative(b.deleteClosedAfterHours, BRIDGE_DEFAULTS.deleteClosedAfterHours),
    codexSources: Array.isArray(b.codexSources) ? b.codexSources.filter((s) => typeof s === 'string') : BRIDGE_DEFAULTS.codexSources,
    fleet: b.fleet?.chatId ? { chatId: b.fleet.chatId, topicId: b.fleet.topicId ?? null,
      everyMinutes: b.fleet.everyMinutes > 0 ? b.fleet.everyMinutes : 60,
      timeFormat: ['date', 'countdown'].includes(b.fleet.timeFormat) ? b.fleet.timeFormat : 'both',
      order: Array.isArray(b.fleet.order) ? b.fleet.order : [],
      always: b.fleet.always && typeof b.fleet.always === 'object' ? b.fleet.always : {} } : null,
    ...fleetGatewayConfig(b.fleetGateway, localBridge(localPath).fleetGateway?.hostToken),
    projects,
  };
}

function localBridge(localPath) {
  try { return JSON.parse(fs.readFileSync(localPath, 'utf8')).bridge ?? {}; } catch { return {}; }
}

/**
 * {fleetGateway, fleetGatewayError}: the push config, or null with the reason a configured one
 * is off. The gateway serves at the root of its origin, https only except on loopback (local
 * development). The host token is a secret: read from the machine-local layer only, so one
 * written into the synced file is ignored.
 */
function fleetGatewayConfig(g, hostToken) {
  const off = (fleetGatewayError) => ({ fleetGateway: null, fleetGatewayError });
  if (g === undefined && hostToken === undefined) return off(null);
  if (typeof hostToken !== 'string' || !hostToken) return off('no bridge.fleetGateway.hostToken in the local settings');
  let url;
  try { url = new URL(g?.url); } catch { return off('bridge.fleetGateway.url missing or not a URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return off('bridge.fleetGateway.url must be https (http only on loopback)');
  if (url.pathname !== '/' || url.search) return off('bridge.fleetGateway.url must be an origin: the gateway serves at its root');
  const every = g.everySeconds ?? 15;
  if (!(every >= 5 && every <= 3600)) return off('bridge.fleetGateway.everySeconds must be 5..3600');
  return { fleetGateway: { url: url.origin, hostToken, everySeconds: every }, fleetGatewayError: null };
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
  } catch { return null; }
}

/** Repo name from an origin URL: `https://h/o/name.git` / `git@h:o/name.git` -> `name`. */
export function repoNameFromUrl(url) {
  const m = /([^/:\\]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Project and branch for a working tree. The project is the origin repo name (so every
 * worktree of one repo lands in one group), falling back to the top-level dir name.
 */
export function gitContext(cwd, { originUrl, branch } = {}) {
  if (!cwd) return { project: null, branch: branch ?? null };
  const origin = originUrl ?? git(cwd, ['remote', 'get-url', 'origin']);
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return {
    project: repoNameFromUrl(origin) ?? (top ? path.basename(top) : path.basename(cwd)),
    branch: branch ?? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

/** Write a file readable only by this user (0600 on POSIX; Windows inherits the profile ACL). */
export function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
