// Shared plugin-launcher logic: resolves the latest installed version of a
// cc-market plugin, finds its CLI script, and spawns it. Falls back to the
// repo source tree when the plugin is not installed (development mode).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

export function launchPlugin(pluginKey, fallbackSubdir, scriptRelPath, {
  nodeArgs = [],
  errorPrefix = pluginKey.split('@')[0],
} = {}) {
  let cliPath = null;
  try {
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const entries = data.plugins?.[pluginKey];
    if (entries?.length) {
      const latest = entries.reduce((a, b) =>
        new Date(a.installedAt) > new Date(b.installedAt) ? a : b
      );
      cliPath = path.join(latest.installPath, ...scriptRelPath.split('/'));
    }
  } catch {}

  if (!cliPath || !fs.existsSync(cliPath)) {
    const repoDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    cliPath = path.join(repoDir, 'cc-market', fallbackSubdir, ...scriptRelPath.split('/'));
  }

  const p = spawn('node', [...nodeArgs, cliPath, ...process.argv.slice(2)], { stdio: 'inherit' });
  p.on('error', (err) => { console.error(`${errorPrefix}: failed to launch:`, err.message); process.exit(1); });
  p.on('exit', (code) => process.exit(code));
}
