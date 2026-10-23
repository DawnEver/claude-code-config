// scripts/runtime/repo-automode.mjs — a repo's own auto-mode rules, for a repo the user trusts.
//
// Claude Code reads `autoMode` only from user settings, managed settings and `--settings`,
// never from a repo's `.claude/settings*.json`. So a repo that wants to teach the classifier
// its toolchain declares `.claude/automode.json` (`{ "autoMode": { ... } }`), and the launcher
// passes it with `--settings` — but only when the repo's `origin` matches the user's trust
// list, since a fragment is an instruction to allow actions. `--settings` autoMode arrays
// CONCATENATE with the user's (measured 2026-10-23 with `claude --settings f auto-mode config`).
//
// Three layers, each with one owner:
//   public mechanism  — this file (every Claude launch goes through buildClaudeInvocation)
//   personal trust    — ~/.claude/trusted-origins, linked from the sync payload; one glob per line
//   repo declaration  — <repo>/.claude/automode.json

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

export const FRAGMENT = path.join('.claude', 'automode.json');
export const TRUST_FILE = 'trusted-origins';

/** `git@host:org/repo.git`, `https://user@host:443/org/repo`, `ssh://git@host/org/repo` -> `host/org/repo`. */
export function originKey(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(u);
  let host, rest;
  if (scp && !u.includes('://')) [, host, rest] = scp;
  else {
    const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
    if (!m) return null;
    [, host, rest] = m;
  }
  return `${host.toLowerCase()}/${rest.replace(/\.git$/, '').replace(/\/+$/, '')}`;
}

/** Glob over an origin key: `*` stays inside one path segment, `**` crosses them. Case-insensitive. */
export function globMatch(pattern, key) {
  const re = pattern.trim().replace(/\.git$/, '').split(/(\*\*|\*)/).map((part) =>
    part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${re}$`, 'i').test(key);
}

/** The trust list: one glob per line, `#` comments. Absent file = trust nothing. */
export function readTrustList(home = os.homedir()) {
  try {
    return readFileSync(path.join(home, '.claude', TRUST_FILE), 'utf8').split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The `--settings` args for the launch directory's repo, and one line saying what was decided.
 * @returns {{ args: string[], notice: string }}
 */
export function repoAutoModeArgs({ cwd = process.cwd(), home = os.homedir(), extraArgs = [],
  runGit = git, trust = readTrustList(home) } = {}) {
  const none = (why) => ({ args: [], notice: `[cc] repo autoMode: not loaded (${why})` });
  if (extraArgs.includes('--settings')) return none('--settings given on the command line');
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return none('not a git repo');
  const fragment = path.join(root, FRAGMENT);
  if (!existsSync(fragment)) return none(`no ${FRAGMENT.replace(/\\/g, '/')}`);
  const key = originKey(runGit(root, ['remote', 'get-url', 'origin']));
  if (!key) return none('repo has no origin');
  if (!trust.some((p) => globMatch(p, key))) return none(`origin ${key} is not in ~/.claude/${TRUST_FILE}`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(fragment, 'utf8')); } catch (e) { return none(`${fragment} is not JSON: ${e.message}`); }
  const keys = Object.keys(parsed ?? {});
  if (keys.length !== 1 || keys[0] !== 'autoMode') return none(`${fragment} must hold only "autoMode", found: ${keys.join(', ') || 'nothing'}`);
  return { args: ['--settings', fragment], notice: `[cc] repo autoMode: loaded ${fragment} (origin ${key})` };
}
