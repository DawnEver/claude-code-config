// prune-cache-hook.js — keep only the latest + currently-installed version of each
// cached cc-market plugin. Run on SessionStart to prevent version bloat.
//
// Strategy: keep the highest version AND the version referenced in
// installed_plugins.json (the one currently loaded). Delete the rest.
// Unused old versions get cleaned on next startup.

import { readdirSync, rmSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CACHE_ROOT = join(process.env.USERPROFILE || process.env.HOME, '.claude', 'plugins', 'cache', 'cc-market');
const INSTALLED_PATH = join(process.env.USERPROFILE || process.env.HOME, '.claude', 'plugins', 'installed_plugins.json');

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

function getInstalledVersions() {
  const installed = {};
  try {
    if (!existsSync(INSTALLED_PATH)) return installed;
    const data = JSON.parse(readFileSync(INSTALLED_PATH, 'utf8'));
    for (const [key, entries] of Object.entries(data.plugins || {})) {
      const name = key.split('@')[0];
      for (const entry of entries) {
        if (entry.installPath && entry.installPath.includes('cache\\cc-market\\')) {
          if (!installed[name]) installed[name] = new Set();
          installed[name].add(entry.version);
        }
      }
    }
  } catch {}
  return installed;
}

let totalRemoved = 0;
const installedVersions = getInstalledVersions();

try {
  for (const plugin of readdirSync(CACHE_ROOT)) {
    const pluginDir = join(CACHE_ROOT, plugin);
    if (!statSync(pluginDir).isDirectory()) continue;

    const versions = readdirSync(pluginDir).filter(v => /^\d+\.\d+\.\d+$/.test(v));
    if (versions.length <= 1) continue;

    versions.sort(compareVersion);
    const keepLatest = versions.pop(); // highest version
    const keepInstalled = installedVersions[plugin] || new Set();
    const keep = new Set([keepLatest, ...keepInstalled]);

    for (const old of versions) {
      if (keep.has(old)) continue;
      const oldDir = join(pluginDir, old);
      try {
        const fileCount = countFiles(oldDir);
        rmSync(oldDir, { recursive: true, force: true });
        totalRemoved += fileCount;
        console.error(`[prune-cache-hook] removed ${plugin}@${old} (${fileCount} files, keeping ${[...keep].join(', ')})`);
      } catch (e) {
        console.error(`[prune-cache-hook] failed to remove ${plugin}@${old}: ${e.message}`);
      }
    }
  }

  if (totalRemoved > 0) {
    console.error(`[prune-cache-hook] done — removed ${totalRemoved} stale files`);
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.error(`[prune-cache-hook] error: ${e.message}`);
}
