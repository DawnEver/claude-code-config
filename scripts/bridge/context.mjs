// scripts/bridge/context.mjs — what the bridge needs to know about this machine and a
// session's working tree. Everything is read through ~/.claude links, never a machine path
// (docs/sync-architecture.md §2): bridge config is the `bridge` block of the shared
// claude_env_settings.json with the machine-local claude_env_settings.local.json merged on
// top, and secrets (bot token, allowlist) exist only in the local layer.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const SHARED_ENV_SETTINGS_PATH = path.join(CLAUDE_DIR, 'claude_env_settings.json');
/** Machine-local runtime dir: daemon port + IPC token + Telegram caches. Never synced. */
export const BRIDGE_RUNTIME_DIR = path.join(CLAUDE_DIR, 'bridge');
export const RUNTIME_FILE = path.join(BRIDGE_RUNTIME_DIR, 'runtime.json');

/** The single source for the bridge's tunable defaults (0 = never for both). */
export const BRIDGE_DEFAULTS = { idleCloseMinutes: 30, deleteClosedAfterHours: 24, observeIntervalSeconds: 60 };

const nonNegative = (v, dflt) => (typeof v === 'number' && v >= 0 ? v : dflt);

/**
 * Normalised bridge config.
 * shared:  bridge.projects.<repo>.chatId, bridge.fallbackChatId, bridge.coordinator,
 *          bridge.idleCloseMinutes, bridge.deleteClosedAfterHours, bridge.observeIntervalSeconds
 * local:   bridge.botToken, bridge.allowedUserIds, bridge.approvalsFromTelegram
 * Either layer may set any key; local wins.
 */
export function readBridgeConfig({ sharedPath = SHARED_ENV_SETTINGS_PATH, localPath = LOCAL_ENV_SETTINGS_PATH } = {}) {
  const merged = readMergedEnvSettings({ sharedPath, localPath }) ?? {};
  const b = merged.bridge ?? {};
  const projects = {};
  for (const [name, p] of Object.entries(b.projects ?? {})) if (p?.chatId) projects[name] = { chatId: p.chatId };
  return {
    botToken: typeof b.botToken === 'string' && !/your-|^$/.test(b.botToken) ? b.botToken : null,
    allowedUserIds: (b.allowedUserIds ?? []).map(Number).filter(Number.isFinite),
    approvalsFromTelegram: b.approvalsFromTelegram === true,
    fallbackChatId: b.fallbackChatId ?? null,
    idleCloseMinutes: nonNegative(b.idleCloseMinutes, BRIDGE_DEFAULTS.idleCloseMinutes),
    deleteClosedAfterHours: nonNegative(b.deleteClosedAfterHours, BRIDGE_DEFAULTS.deleteClosedAfterHours),
    observeIntervalSeconds: nonNegative(b.observeIntervalSeconds, BRIDGE_DEFAULTS.observeIntervalSeconds),
    coordinator: typeof b.coordinator === 'string' && b.coordinator ? b.coordinator : null,
    projects,
  };
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
