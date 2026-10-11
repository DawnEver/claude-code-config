// prune-cache-hook.js — prune stale cached plugin versions across ALL marketplaces.
// Run on SessionStart to prevent version bloat.
//
// Keep the latest version of each plugin plus every version a running process references
// (Claude sessions and their MCP servers load plugin code from the cache by path, often
// lazily: deleting a version a live server still imports from breaks it mid-session).
// The process scan runs synchronously, and only when there is something to delete — rare,
// right after a plugin update. A failed scan deletes nothing: an extra directory on disk
// costs nothing, a deleted live one breaks a session.

import { readdirSync, rmSync, statSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { isMain } from '../shared/is-main.mjs';

const CACHE_ROOTS = [
  join(homedir(), '.claude', 'plugins', 'cache'),
  join(homedir(), '.codex', 'plugins', 'cache'),
];
const VERSION = /^\d+\.\d+\.\d+$/;

function compareVersion(a, b) {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const d = (ap[i] || 0) - (bp[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Command lines -> Set of `<marketplace>/<plugin>/<version>` they reference. */
export function liveVersions(text) {
  const live = new Set();
  for (const [, mp, name, version] of String(text).matchAll(/[\\/]cache[\\/]([^\\/\s"']+)[\\/]([^\\/\s"']+)[\\/](\d+\.\d+\.\d+)(?=[\\/\s"']|$)/g))
    live.add(`${mp}/${name}/${version}`);
  return live;
}

/** The versions of one plugin to delete: all but the latest and the live ones. */
export function staleVersions(versions, isLive) {
  const sorted = versions.filter((v) => VERSION.test(v)).sort(compareVersion);
  sorted.pop();
  return sorted.filter((v) => !isLive(v));
}

/** Every running process's command line mentioning a plugin cache; throws on failure. */
function scanProcesses() {
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*plugins*cache*' } | ForEach-Object { $_.CommandLine }";
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 8 << 20, windowsHide: true });
  }
  return execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 << 20 });
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  return n;
}

function subdirs(dir) {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

export function prune({ roots = CACHE_ROOTS, scan = scanProcesses, log = (m) => console.error(m) } = {}) {
  const plugins = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const mp of subdirs(root)) for (const name of subdirs(join(root, mp))) {
      const dir = join(root, mp, name);
      const versions = readdirSync(dir);
      if (staleVersions(versions, () => false).length) plugins.push({ dir, key: `${mp}/${name}`, versions });
    }
  }
  if (!plugins.length) return 0;

  let live;
  try { live = liveVersions(scan()); } catch (e) {
    log(`[prune-cache-hook] process scan failed, nothing pruned: ${e.message}`);
    return 0;
  }
  let removed = 0;
  for (const { dir, key, versions } of plugins) {
    for (const old of staleVersions(versions, (v) => live.has(`${key}/${v}`))) {
      const oldDir = join(dir, old);
      try {
        const files = countFiles(oldDir);
        rmSync(oldDir, { recursive: true, force: true });
        removed += files;
        log(`[prune-cache-hook] removed ${key}@${old} (${files} files)`);
      } catch (e) {
        log(`[prune-cache-hook] failed to remove ${key}@${old}: ${e.message}`);
      }
    }
  }
  return removed;
}

if (isMain(import.meta.url)) {
  try { prune(); } catch (e) { if (e.code !== 'ENOENT') console.error(`[prune-cache-hook] error: ${e.message}`); }
}
