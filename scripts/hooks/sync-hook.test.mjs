import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoRootFrom, REPO, formatPull, formatReminder, formatMergeFailure, isStartup } from './sync-hook.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('repoRootFrom walks up from a hook file to the repo root', () => {
  const root = repoRootFrom(path.join(HERE, 'sync-hook.js'));
  assert.equal(root, path.resolve(HERE, '..', '..'));
});

// The cross-host guarantee: the repo is found from the module's own location,
// so a host with a different username, drive letter, or checkout path needs no
// configuration. If this fails, the hook is silently doing nothing.
test('REPO resolves to a real git working tree on this host', () => {
  assert.ok(fs.existsSync(path.join(REPO, '.git')), `${REPO} is not a git repo`);
  assert.ok(fs.existsSync(path.join(REPO, 'scripts', 'hooks', 'sync-hook.js')));
});

test('formatPull stays silent when there is nothing to report', () => {
  assert.equal(formatPull(null), null);          // already current, or skipped
  assert.equal(formatPull({ pulled: 0 }), null);
});

test('formatPull reports a fast-forward by count', () => {
  assert.match(formatPull({ pulled: 3 }), /fast-forwarded 3 commit/);
});

test('formatPull surfaces a refusal without pretending it synced', () => {
  assert.match(formatPull({ pulled: 0, note: '2 unpushed commit(s)' }), /not updated: 2 unpushed/);
});

test('formatReminder stays silent on a clean, fully pushed tree', () => {
  assert.equal(formatReminder({ dirty: 0, ahead: 0 }), null);
  assert.equal(formatReminder({}), null);
});

test('formatReminder names each side of the backlog independently', () => {
  assert.match(formatReminder({ dirty: 4, ahead: 0 }), /4 uncommitted file/);
  assert.match(formatReminder({ dirty: 0, ahead: 2 }), /2 unpushed commit/);
  const both = formatReminder({ dirty: 1, ahead: 1 });
  assert.match(both, /1 unpushed commit\(s\) · 1 uncommitted file\(s\)/);
});

// The advice has to match the state: telling someone to `push` when nothing is
// committed yet is a dead end.
test('formatReminder suggests the action that is actually next', () => {
  assert.match(formatReminder({ ahead: 2, dirty: 0 }), /push: git -C "/);
  assert.match(formatReminder({ ahead: 0, dirty: 3 }), /review: git -C "/);
  assert.doesNotMatch(formatReminder({ ahead: 0, dirty: 3 }), /push:/);
});

// A branch with no upstream is never pulled, so silence would be
// indistinguishable from "already current".
test('formatReminder breaks the silence on a branch that can never pull', () => {
  const msg = formatReminder({ dirty: 0, ahead: 0, noUpstream: true });
  assert.match(msg, /no upstream set/);
  assert.match(msg, /--set-upstream-to/);
  assert.equal(formatReminder({ noUpstream: false }), null);
});

test('formatMergeFailure reports an interruption as the integrity event it is', () => {
  const killed = formatMergeFailure({ killed: true, signal: 'SIGTERM' });
  assert.match(killed, /interrupted mid-checkout/);
  assert.match(killed, /git status/);
});

test('formatMergeFailure surfaces git\'s own reason, not a guess', () => {
  const err = Object.assign(new Error('x'), {
    stderr: 'error: Your local changes to the following files would be overwritten by merge:\n\tscripts/hooks/x.js\n',
  });
  const note = formatMergeFailure(err);
  assert.match(note, /git refused the update: error: Your local changes/);
  assert.doesNotMatch(note, /\n/, 'one line — it goes into a systemMessage');
});

test('formatMergeFailure still says something useful with no stderr', () => {
  assert.equal(formatMergeFailure(new Error('boom')), 'git refused the update');
  assert.equal(formatMergeFailure(undefined), 'git refused the update');
});

// SessionStart also fires on resume/clear/compact. Pulling on a compact would
// move the tree under a live session for no gain.
test('only a fresh session is allowed to move the tree', () => {
  assert.equal(isStartup({ source: 'startup' }), true);
  assert.equal(isStartup({}), true);              // version-tolerance: fail open
  assert.equal(isStartup(undefined), true);
  for (const source of ['resume', 'clear', 'compact']) {
    assert.equal(isStartup({ source }), false, `${source} must not trigger a pull`);
  }
});

// ── integration: real git repos ──
// The fast-forward is the one path that modifies the working tree, so it is
// exercised against real clones rather than a mock.

const IDENT = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...IDENT },
  }).trim();
}

/** A bare origin plus two clones, `a` and `b`, with one shared commit. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hook-'));
  const origin = path.join(root, 'origin.git');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '--quiet');
  git(root, 'clone', '--quiet', origin, a);
  git(a, 'commit', '--allow-empty', '--quiet', '-m', 'init');
  git(a, 'push', '--quiet', '-u', 'origin', 'HEAD');
  git(root, 'clone', '--quiet', origin, b);
  return { root, origin, a, b };
}

/** Run the hook as a separate process, as the harness would. */
function runHook(repo, mode, payload = {}) {
  const raw = execFileSync(process.execPath, [path.join(HERE, 'sync-hook.js'), mode], {
    cwd: repo, encoding: 'utf8', input: JSON.stringify(payload),
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...IDENT, CLAUDE_SYNC_REPO: repo },
  }).trim();
  return raw ? JSON.parse(raw).systemMessage : null;
}

// A checkout's line endings are a legitimate per-host setting (core.autocrlf),
// so compare content, not bytes.
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('integration: a behind host fast-forwards and actually gets the file', () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(a, 'from-a.txt'), 'hello\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'from a');
  git(a, 'push', '--quiet');

  const notice = runHook(b, '--pull', { source: 'startup' });

  assert.match(notice, /fast-forwarded 1 commit/);
  assert.equal(readText(path.join(b, 'from-a.txt')), 'hello\n');
});

test('integration: a diverged host is told, never merged or rebased', () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(a, 'from-a.txt'), 'theirs\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'from a');
  git(a, 'push', '--quiet');

  git(b, 'commit', '--allow-empty', '--quiet', '-m', 'local work');
  const before = git(b, 'rev-parse', 'HEAD');

  const notice = runHook(b, '--pull', { source: 'startup' });

  assert.match(notice, /not updated/);
  assert.doesNotMatch(notice, /fast-forwarded/);
  assert.equal(git(b, 'rev-parse', 'HEAD'), before, 'local commit must survive');
  assert.ok(!fs.existsSync(path.join(b, 'from-a.txt')), 'upstream must not be applied');
});

test('integration: an up-to-date host stays completely silent', () => {
  const { b } = fixture();
  assert.equal(runHook(b, '--pull', { source: 'startup' }), null);
});

test('integration: a non-startup session never moves the tree', () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(a, 'from-a.txt'), 'hello\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'from a');
  git(a, 'push', '--quiet');

  assert.equal(runHook(b, '--pull', { source: 'compact' }), null);
  assert.ok(!fs.existsSync(path.join(b, 'from-a.txt')));
});

test('integration: offline is a silent no-op, not a blocked session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hook-offline-'));
  git(root, 'init', '--quiet');
  git(root, 'commit', '--allow-empty', '--quiet', '-m', 'init');

  // No remote configured at all — the fetch cannot succeed.
  assert.equal(runHook(root, '--pull', { source: 'startup' }), null);
  assert.ok(fs.existsSync(path.join(root, '.git')), 'repo must be left intact');
});

test('integration: the reminder reports real uncommitted work', () => {
  const { b } = fixture();
  assert.equal(runHook(b, '--remind'), null, 'clean clone is silent');

  fs.writeFileSync(path.join(b, 'scratch.txt'), 'wip\n');
  assert.match(runHook(b, '--remind'), /1 uncommitted file/);
});

