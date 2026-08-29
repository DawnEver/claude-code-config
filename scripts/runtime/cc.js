#!/usr/bin/env node
// cc.js — Claude Code provider launcher.
//
// Thin spawn wrapper around `cc-launcher.mjs` (the pure env+args projection).
// Provider config lives in `claude_env_settings.json` under `providers.<name>`.
// Run `node scripts/setup/setup.js` to install the `ccc` / `ccds` / `cckm` /
// `ccgmi` aliases; those wrappers exec this script with the provider name.

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { buildClaudeInvocation } from './cc-launcher.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read the shared registry through the link setup already materialized, not a repo-relative
// path: claude_env_settings.json lives in the sync payload, which may sit outside the repo.
// `~/.claude/claude_env_settings.json` is the per-host indirection that exists for exactly
// this — the same convention as ~/.claude/system-prompt.

// Prefer the link setup materializes; fall back to the repo-relative path so the launcher
// still works BEFORE the first setup run (where the old repo-relative resolution used to).
function resolveEnvSettingsPath() {
  const linked = join(homedir(), '.claude', 'claude_env_settings.json');
  if (existsSync(linked)) return linked;
  return join(REPO_ROOT, 'claude_env_settings.json');
}

const envSettingsPath = resolveEnvSettingsPath();

const argv = process.argv.slice(2);
const provider = argv[0] && !argv[0].startsWith('-') ? argv.shift() : '';
const extraArgs = argv;

const { env, args, error } = buildClaudeInvocation({
  provider: provider || null,
  extraArgs,
  envSettingsPath,
});

if (error) {
  console.error(error);
  process.exit(1);
}

console.log(provider ? `[cc] Using provider: ${provider}` : '[cc] Using Claude (official subscription)');

const isWindows = process.platform === 'win32';
const child = spawn('claude', args, { env, stdio: 'inherit', shell: isWindows });
child.on('exit', code => process.exit(code ?? 0));
