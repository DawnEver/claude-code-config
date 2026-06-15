// prune-cache-hook.js — prune stale cached plugin versions across ALL marketplaces.
// Run on SessionStart to prevent version bloat.
//
// Strategy: keep the latest version + any version currently referenced by a
// live process. Live-process detection scans command lines across all
// processes (cross-platform) to avoid deleting versions still loaded by
// running Claude Code sessions or MCP servers.

import { readdirSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_ROOT = join(homedir(), '.claude', 'plugins', 'cache');

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

function getLiveVersions() {
  const inUse = {};
  try {
    const isWin = process.platform === 'win32';
    // execFileSync (no shell) — Node spawns the target directly, so on Windows
    // it never goes through `cmd.exe /c` (avoids EDR child_process+cmd.exe alerts).
    let output;
    if (isWin) {
      // Get-WmiObject (not Get-CimInstance) — CIM returns null CommandLine for some processes.
      // Use -like (not -match) — wildcard avoids regex backslash-escaping hell.
      // $pid excludes the scanner PowerShell process itself.
      const ps = "Get-WmiObject Win32_Process | Where-Object { $_.ProcessId -ne $pid -and $_.CommandLine -like '*plugins*cache*' } | ForEach-Object { $_.CommandLine }";
      output = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    } else {
      // Run `ps` directly and filter in JS — no shell pipeline needed.
      const raw = execFileSync('ps', ['aux'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      output = raw.split('\n').filter(line => line.includes('plugins/cache')).join('\n');
    }
    const regex = /[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/](\d+\.\d+\.\d+)/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      const [, mp, name, version] = match;
      const key = mp + '/' + name;
      if (!inUse[key]) inUse[key] = new Set();
      inUse[key].add(version);
    }
    if (Object.keys(inUse).length > 0) {
      console.error(`[prune-cache-hook] live versions: ${JSON.stringify(Object.fromEntries(Object.entries(inUse).map(([k, v]) => [k, [...v]])))}`);
    }
  } catch (e) {
    console.error(`[prune-cache-hook] live scan failed: ${e.message}`);
  }
  return inUse;
}

let totalRemoved = 0;
const liveVersions = getLiveVersions();

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
      const keepLive = liveVersions[key] || new Set();
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
} catch (e) {
  if (e.code !== 'ENOENT') console.error(`[prune-cache-hook] error: ${e.message}`);
}
