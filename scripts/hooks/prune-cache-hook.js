// prune-cache-hook.js — report stale cached plugin versions across ALL marketplaces.
// Automatic runs never delete: a shared daemon's lazy references are not visible in argv.
//
// Keep the latest version of each plugin plus every version a running process references
// (Claude sessions and their MCP servers load plugin code from the cache by path, often
// lazily: deleting a version a live server still imports from breaks it mid-session).
// The process scan runs synchronously, and only when there are stale candidates — rare,
// right after a plugin update. A failed scan deletes nothing: an extra directory on disk
// costs nothing, a deleted live one breaks a session.
//
// --orphans [--apply]: the door for doctor's codex-plugin-orphan-cache. Lists (and with --apply
// removes) Codex cache plugin dirs no marketplace lists, under the same scan: a dir a running
// process references is kept and named; a failed scan removes nothing; a running `codex
// app-server` (managed daemon or proxy) removes nothing, because the app-server serves plugin
// skills and MCP servers and nothing shows it never loads one lazily.

import { readdirSync, rmSync, statSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { isMain } from '../shared/is-main.mjs';
import { resolveCodexHome } from '../shared/codex-home.mjs';
import { readMarketDir } from '../shared/market-dir.mjs';

const CACHE_ROOTS = [
  join(homedir(), '.claude', 'plugins', 'cache'),
  join(resolveCodexHome(), 'plugins', 'cache'),
];
const VERSION = /^\d+\.\d+\.\d+$/;
// A Codex app-server (managed daemon or proxy) can hold plugin paths for lazy loading without naming them in argv.
// `app-server daemon <verb>` (pid-update-loop, stop, version) only manages that process and serves no plugin code.
const DAEMON = /\bcodex(?:\.exe)?["']?\s+app-server\b(?!\s+daemon\b)/i;

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
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*plugins*cache*' -or $_.Name -eq 'codex.exe' } | ForEach-Object { $_.CommandLine }";
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

export function prune({ roots = CACHE_ROOTS, scan = scanProcesses, reportOnly = true, log = (m) => console.error(m) } = {}) {
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

  let live, processes;
  try { processes = scan(); live = liveVersions(processes); } catch (e) {
    log(`[prune-cache-hook] process scan failed, nothing pruned: ${e.message}`);
    return 0;
  }
  let removed = 0;
  // A daemon can retain plugin paths for lazy loading without naming them in its argv.
  const unknownOwnership = DAEMON.test(processes);
  for (const { dir, key, versions } of plugins) {
    for (const old of staleVersions(versions, (v) => live.has(`${key}/${v}`))) {
      const oldDir = join(dir, old);
      if (reportOnly || unknownOwnership) {
        log(`[prune-cache-hook] candidate ${key}@${old} not removed (${unknownOwnership ? 'Codex daemon ownership unknown' : 'report-only'})`);
        continue;
      }
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

/** `{ 'cc-market': Set<plugin name> }` from cc-market's Codex manifest, or null when unreadable. */
export function codexMarketListing(marketDir) {
  if (!marketDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(marketDir, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    return { 'cc-market': new Set((parsed.plugins ?? []).map((p) => p.name)) };
  } catch { return null; }
}

/** Plugin dirs under `root` whose marketplace is in `listed` but does not list them: `mp/name`. */
export function orphanPlugins(root, listed) {
  if (!listed || !existsSync(root)) return [];
  return Object.entries(listed).filter(([mp]) => existsSync(join(root, mp)))
    .flatMap(([mp, names]) => subdirs(join(root, mp)).filter((n) => !names.has(n)).map((n) => `${mp}/${n}`));
}

/** List orphans; with `apply`, remove each no running process references. */
export function pruneOrphans({ root = CACHE_ROOTS[1], listed, scan = scanProcesses, apply = false, log = (m) => console.error(m) } = {}) {
  const orphans = orphanPlugins(root, listed);
  const out = { orphans, removed: [], kept: [] };
  for (const key of orphans) log(`[prune-cache-hook] orphan ${key}: ${join(root, ...key.split('/'))}`);
  if (!orphans.length || !apply) return out;
  let processes;
  try { processes = String(scan()); } catch (e) {
    log(`[prune-cache-hook] process scan failed, nothing removed: ${e.message}`);
    return out;
  }
  if (DAEMON.test(processes)) {
    log('[prune-cache-hook] a Codex app-server is running, nothing removed: it may load plugin code lazily; stop Codex and re-run');
    return out;
  }
  const lines = processes.replaceAll('\\', '/').split(/\r?\n/);
  for (const key of orphans) {
    const dir = `/cache/${key}`;
    if (lines.some((l) => l.split(dir).slice(1).some((rest) => /^([/\s"']|$)/.test(rest)))) {
      out.kept.push(key);
      log(`[prune-cache-hook] orphan ${key} kept: a running process references it`);
      continue;
    }
    try {
      rmSync(join(root, ...key.split('/')), { recursive: true, force: true });
      out.removed.push(key);
      log(`[prune-cache-hook] removed orphan ${key}`);
    } catch (e) {
      log(`[prune-cache-hook] failed to remove orphan ${key}: ${e.message}`);
    }
  }
  return out;
}

if (isMain(import.meta.url) && process.argv.includes('--orphans')) {
  const market = readMarketDir();
  const listed = codexMarketListing(market.dir);
  if (!listed) {
    console.error(`[prune-cache-hook] no readable cc-market Codex manifest, nothing listed: ${market.why ?? market.dir}`);
    process.exitCode = 1;
  } else pruneOrphans({ listed, apply: process.argv.includes('--apply') });
} else if (isMain(import.meta.url)) {
  try { prune(); } catch (e) { if (e.code !== 'ENOENT') console.error(`[prune-cache-hook] error: ${e.message}`); }
}
