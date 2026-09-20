#!/usr/bin/env node
// sync-hook.js — keep the cc-config working tree current across hosts.
//
// Two modes, wired to two hook events in claude_settings.json:
//   --pull    SessionStart: fast-forward the repo onto its upstream, so a
//             session starts from the freshest tree. Never blocks the session.
//   --remind  SessionEnd:   report uncommitted files / unpushed commits. The
//             outbound direction stays an explicit user action by design — see
//             .claude/memory/2026/06/06/feedback-no-auto-push.md.
//
// Cross-host rules this file obeys (mixed OS, usernames, and drive letters):
//   * No absolute path, drive letter, branch name, or remote name is assumed.
//     The repo root comes from this module's own location: setup links
//     ~/.claude/scripts at the repo, and Node resolves a module through the
//     link to its real path on every platform.
//   * Git is never allowed to prompt (GIT_TERMINAL_PROMPT=0) and every network
//     step is bounded, so an offline host or a credential prompt cannot stall
//     startup.
//   * Only plumbing output is parsed (porcelain, rev-list). Git's human-facing
//     text is localised and is never matched against.
//   * Nothing here is fatal. Every failure degrades to a silent no-op, and a
//     notice goes out via systemMessage — user-visible, never model context.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isMain } from '../shared/is-main.mjs';

// Bounded so a slow or offline host retries next session instead of hanging
// this one. Override from the `env` block of claude_settings.json.
const FETCH_TIMEOUT_MS = Number(process.env.CLAUDE_SYNC_FETCH_TIMEOUT_MS) || 6000;
const LOCAL_TIMEOUT_MS = 5000;

// Deliberately far above any legitimate local fast-forward. A timeout here is
// not a safety net: execFileSync enforces it by killing git, and killing a merge
// partway through a working-tree update leaves some files advanced and others
// not. This bound exists only to contain a pathological hang, and a trip is
// reported as the data-integrity event it is.
const MERGE_TIMEOUT_MS = 60000;

/** Repo root for a module living at <repo>/scripts/hooks/<file>. */
export function repoRootFrom(modulePath) {
  return path.resolve(path.dirname(modulePath), '..', '..');
}

// Derived from this module's location, which is the cross-host guarantee: no
// username, drive letter, or checkout path is baked in. CLAUDE_SYNC_REPO is the
// escape hatch for a repo laid out differently (and for the integration tests).
export const REPO = process.env.CLAUDE_SYNC_REPO || repoRootFrom(fileURLToPath(import.meta.url));

function git(args, { timeout = LOCAL_TIMEOUT_MS, allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

// `.git` is a directory in a normal clone and a file in a linked worktree;
// either way it means this is a repo.
const isRepo = () => fs.existsSync(path.join(REPO, '.git'));

// The upstream commit, or null when the branch has no upstream configured —
// normal on a freshly cloned host, and not an error.
function upstreamCommit() {
  return git(['rev-parse', '--verify', '--quiet', '@{u}'], { allowFail: true });
}

function count(...args) {
  const n = Number(git(['rev-list', '--count', ...args], { allowFail: true }));
  return Number.isFinite(n) ? n : 0;
}

// Commits on HEAD that no remote has: the upstream range when one is set,
// otherwise "not reachable from any remote ref" — which is what a host with no
// upstream configured needs to hear.
export function unpushedCount() {
  return upstreamCommit() ? count('@{u}..HEAD') : count('HEAD', '--not', '--remotes');
}

function dirtyCount() {
  const out = git(['status', '--porcelain'], { allowFail: true });
  return out ? out.split('\n').filter(Boolean).length : 0;
}

/** Pull-mode notice, or null when there is nothing worth saying. */
export function formatPull(result) {
  if (!result) return null;                       // already current, or skipped
  const { pulled, note } = result;
  if (note) return `[cc-config] not updated: ${note}`;
  if (pulled > 0) return `[cc-config] fast-forwarded ${pulled} commit(s) from upstream`;
  return null;
}

/** Reminder notice, or null when the tree is clean and fully pushed. */
export function formatReminder({ dirty = 0, ahead = 0, noUpstream = false } = {}) {
  const parts = [];
  if (ahead > 0) parts.push(`${ahead} unpushed commit(s)`);
  if (dirty > 0) parts.push(`${dirty} uncommitted file(s)`);
  // A branch with no upstream is never fast-forwarded by the pull half, and
  // silence there is indistinguishable from "already current". Say so.
  if (noUpstream) parts.push('no upstream set — this host will never auto-update');
  if (!parts.length) return null;

  const action = ahead > 0
    ? `push: git -C "${REPO}" push`
    : dirty > 0
      ? `review: git -C "${REPO}" status`
      : `set one: git -C "${REPO}" branch --set-upstream-to=origin/<branch>`;
  return `[cc-config] ${parts.join(' · ')} — ${action}`;
}

/**
 * Why a fast-forward did not happen, in git's own words where possible.
 * Reporting every failure as "local edits" hides the one case that needs
 * attention: a merge killed mid-checkout leaves a half-updated tree.
 */
export function formatMergeFailure(err) {
  if (err?.killed || err?.signal) {
    return 'update interrupted mid-checkout — verify with `git status`';
  }
  const lines = String(err?.stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Git states the reason on its `error:`/`fatal:` line and lists the affected
  // paths after it, so the primary line is the summary — not the last line.
  const reason = lines.find((l) => /^(error|fatal):/i.test(l)) || lines[0] || '';
  const clipped = reason.length > 160 ? `${reason.slice(0, 157)}...` : reason;
  return clipped ? `git refused the update: ${clipped}` : 'git refused the update';
}

// ── modes ──

async function runPull() {
  if (!isRepo()) return null;

  // A held index.lock means another git process (another session, a background
  // fetch) is mid-write. That is transient and expected — stay quiet.
  const gitDir = git(['rev-parse', '--git-dir'], { allowFail: true });
  if (!gitDir) return null;
  if (fs.existsSync(path.join(path.resolve(REPO, gitDir), 'index.lock'))) return null;

  // Network step, isolated and bounded. Offline, no remote, or an auth prompt
  // all land here and are all normal.
  try {
    git(['fetch', '--quiet', '--no-tags'], { timeout: FETCH_TIMEOUT_MS });
  } catch {
    return null;
  }

  const up = upstreamCommit();
  if (!up || up === git(['rev-parse', 'HEAD'], { allowFail: true })) return null;

  const behind = count(`HEAD..${up}`);
  const ahead = count(`${up}..HEAD`);

  // Local commits the upstream lacks: ff-only would refuse, and merging or
  // rebasing unattended is exactly what must not happen here. Report only.
  if (ahead > 0) return { pulled: 0, note: `${ahead} unpushed commit(s) — needs a manual merge or push` };

  try {
    git(['merge', '--ff-only', up], { timeout: MERGE_TIMEOUT_MS });
  } catch (err) {
    return { pulled: 0, note: formatMergeFailure(err) };
  }

  // A pull replaces inodes, which breaks the hard link claude-hud requires
  // (docs/sync-architecture.md §10). SessionStart also runs setup-check-hook,
  // but hook order within an event is not guaranteed, so repair here too.
  try {
    const { checkLinks } = await import('../setup/check-links.js');
    checkLinks();
  } catch {}

  return { pulled: behind };
}

function runRemind() {
  if (!isRepo()) return null;
  const hasRemote = Boolean(git(['remote'], { allowFail: true }));
  return formatReminder({
    dirty: dirtyCount(),
    ahead: unpushedCount(),
    noUpstream: hasRemote && !upstreamCommit(),
  });
}

// ── hook plumbing ──

// Hooks receive their payload on stdin. Absent stdin (manual run) or a stalled
// writer must not hold the session open.
function readPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = '';
    const done = (payload) => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(payload);
    };
    const timer = setTimeout(() => done({}), 2000);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      try { done(JSON.parse(raw || '{}')); } catch { done({}); }
    });
    process.stdin.on('error', () => done({}));
  });
}

// SessionStart fires on startup, resume, clear, and compact. Only a fresh
// session should move the tree out from under a running one; an unrecognised
// or absent source is treated as a startup so the sync is not silently lost.
export function isStartup(payload) {
  const source = payload?.source;
  return !source || source === 'startup';
}

async function main() {
  const mode = process.argv[2];
  const payload = await readPayload();
  let notice = null;

  if (mode === '--pull') {
    if (isStartup(payload)) notice = formatPull(await runPull());
  } else if (mode === '--remind') {
    notice = runRemind();
  } else {
    process.stderr.write('[sync-hook] usage: sync-hook.js --pull|--remind\n');
    return;
  }

  // Silent when there is nothing to report.
  if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice }));
}

// Only run when invoked, so the pure helpers above stay importable by tests.
// isMain realpaths both sides: this file is wired as `node ~/.claude/scripts/...`,
// and a plain path comparison would silently disable the hook.
if (isMain(import.meta.url)) {
  main().catch((err) => process.stderr.write(`[sync-hook] ${err.message}\n`));
}
