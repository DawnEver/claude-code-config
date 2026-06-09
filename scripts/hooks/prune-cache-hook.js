// prune-cache-hook.js — keep only the latest version of each cached cc-market plugin
// Run on SessionStart to prevent version bloat (~800+ stale files across old versions).

import { readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const CACHE_ROOT = join(process.env.USERPROFILE || process.env.HOME, '.claude', 'plugins', 'cache', 'cc-market');

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

let totalRemoved = 0;

try {
  for (const plugin of readdirSync(CACHE_ROOT)) {
    const pluginDir = join(CACHE_ROOT, plugin);
    if (!statSync(pluginDir).isDirectory()) continue;

    const versions = readdirSync(pluginDir).filter(v => /^\d+\.\d+\.\d+$/.test(v));
    if (versions.length <= 1) continue;

    versions.sort(compareVersion);
    const keep = versions.pop(); // highest version
    for (const old of versions) {
      const oldDir = join(pluginDir, old);
      try {
        const fileCount = countFiles(oldDir);
        rmSync(oldDir, { recursive: true, force: true });
        totalRemoved += fileCount;
        console.error(`[prune-cache-hook] removed ${plugin}@${old} (${fileCount} files, keeping ${keep})`);
      } catch (e) {
        console.error(`[prune-cache-hook] failed to remove ${plugin}@${old}: ${e.message}`);
      }
    }
  }

  if (totalRemoved > 0) {
    console.error(`[prune-cache-hook] done — removed ${totalRemoved} stale files`);
  }
} catch (e) {
  // Cache dir might not exist yet — that's fine
  if (e.code !== 'ENOENT') console.error(`[prune-cache-hook] error: ${e.message}`);
}
