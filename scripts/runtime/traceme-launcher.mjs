#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';

const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

let cliPath = null;
try {
  const data = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  const entries = data.plugins?.['traceme@cc-market'];
  if (entries?.length) {
    const latest = entries.reduce((a, b) =>
      new Date(a.installedAt) > new Date(b.installedAt) ? a : b
    );
    cliPath = path.join(latest.installPath, 'scripts', 'traceme-cli.mjs');
  }
} catch {}

if (!cliPath || !fs.existsSync(cliPath)) {
  // Fallback: repo source (development)
  const repoDir = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
  cliPath = path.join(repoDir, 'cc-market', 'traceme', 'scripts', 'traceme-cli.mjs');
}

const p = spawn('node', [cliPath, ...process.argv.slice(2)], { stdio: 'inherit' });
p.on('exit', (code) => process.exit(code));
