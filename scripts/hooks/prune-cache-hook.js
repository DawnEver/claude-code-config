// prune-cache-hook.js — prune stale cached plugin versions across ALL marketplaces.
// Run on SessionStart to prevent version bloat.
//
// Strategy: keep the latest version + any version currently referenced by a
// live process. Live-process detection scans command lines across all processes
// (cross-platform) to avoid deleting versions still loaded by running Claude Code
// sessions or MCP servers. The scan runs in a detached background child process
// and writes results to a cache file; the current run reads the PREVIOUS scan's
// cache so SessionStart is never blocked by process enumeration.

import { readdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CACHE_ROOT = join(homedir(), '.claude', 'plugins', 'cache');
const LIVE_CACHE = join(homedir(), '.claude', 'plugins', '.prune-live-cache.json');

function compareVersion(a, b) {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const d = (ap[i] || 0) - (bp[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { n += countFiles(join(dir, entry.name)); }
    else { n++; }
  }
  return n;
}

// Read the cached live-version map from the previous background scan.
function readCachedLiveVersions() {
  try {
    if (!existsSync(LIVE_CACHE)) return {};
    return JSON.parse(readFileSync(LIVE_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

// Launch a non-blocking background scan for live versions. Results are written
// to LIVE_CACHE and picked up by the NEXT SessionStart run — the current run
// uses the previous cache, so session startup is never delayed by scanning.
function spawnLiveVersionScan() {
  const script = `
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const CACHE_ROOT = ${JSON.stringify(CACHE_ROOT)};
const LIVE_CACHE = ${JSON.stringify(LIVE_CACHE)};
const isWin = ${JSON.stringify(process.platform === 'win32')};

const inUse = {};
try {
  let output;
  if (isWin) {
    const ps = "Get-WmiObject Win32_Process | Where-Object { $_.ProcessId -ne $pid -and $_.CommandLine -like '*plugins*cache*' } | ForEach-Object { $_.CommandLine }";
    output = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576, windowsHide: true });
  } else {
    const raw = execFileSync('ps', ['aux'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 });
    output = raw.split('\\n').filter(line => line.includes('plugins/cache')).join('\\n');
  }
  const regex = /[\\\\/]cache[\\\\/]([^\\\\/]+)[\\\\/]([^\\\\/]+)[\\\\/](\\d+\\.\\d+\\.\\d+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const [, mp, name, version] = match;
    const key = mp + '/' + name;
    if (!inUse[key]) inUse[key] = [];
    if (!inUse[key].includes(version)) inUse[key].push(version);
  }
} catch {}  // scan failure is non-fatal — next run just has no live cache

mkdirSync(dirname(LIVE_CACHE), { recursive: true });
writeFileSync(LIVE_CACHE, JSON.stringify(inUse), 'utf8');
`;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}  // spawn failure is non-fatal
}

let totalRemoved = 0;
const liveVersions = readCachedLiveVersions();

try {
  for (const mp of readdirSync(CACHE_ROOT)) {
    const mpDir = join(CACHE_ROOT, mp);
    if (!statSync(mpDir).isDirectory()) continue;

    for (const plugin of readdirSync(mpDir)) {
      const pluginDir = join(mpDir, plugin);
      if (!statSync(pluginDir).isDirectory()) continue;

      const versions = readdirSync(pluginDir).filter(v => /^\d+\.\d+\.\d+$/.test(v));
      if (versions.length <= 1) continue;

      versions.sort(compareVersion);
      const latest = versions.pop();
      const key = mp + '/' + plugin;
      const keepLive = new Set(liveVersions[key] || []);
      const keep = new Set([latest, ...keepLive]);

      for (const old of versions) {
        if (keep.has(old)) continue;
        const oldDir = join(pluginDir, old);
        try {
          const fileCount = countFiles(oldDir);
          rmSync(oldDir, { recursive: true, force: true });
          totalRemoved += fileCount;
          console.error(`[prune-cache-hook] removed ${key}@${old} (${fileCount} files, keeping ${[...keep].join(', ')})`);
        } catch (e) {
          console.error(`[prune-cache-hook] failed to remove ${key}@${old}: ${e.message}`);
        }
      }
    }
  }

  if (totalRemoved > 0) {
    console.error(`[prune-cache-hook] done — removed ${totalRemoved} stale files`);
  }

  // Kick off the background scan for next time AFTER pruning completes.
  spawnLiveVersionScan();
} catch (e) {
  if (e.code !== 'ENOENT') console.error(`[prune-cache-hook] error: ${e.message}`);
}
