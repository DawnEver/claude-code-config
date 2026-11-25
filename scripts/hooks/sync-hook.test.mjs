import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { depsChanged, updateOwnDeps, venvStateFile, repoRootFrom, REPO, formatPull, formatReminder, parseBranchStatus, formatMergeFailure, isStartup } from './sync-hook.js';
import { tempDir } from '../shared/temp-dir.mjs';

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

test('formatPull reports a successful update whose repair needs retrying', () => {
  const msg = formatPull({ pulled: 2, repairError: 'payload busy' });
  assert.match(msg, /fast-forwarded 2 commit/);
  assert.match(msg, /repair failed: payload busy/);
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
  const root = tempDir('sync-hook-');
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
// A successful pull re-runs checkLinks(), which writes into ~/.claude, ~/.codex and ~/.gemini:
// the child gets a throwaway HOME so a test never edits the live hosts (it once broke agy's hooks.json).
const TEST_HOME = tempDir('sync-hook-home-');

function runHook(repo, mode, payload = {}, extraEnv = {}) {
  // A session started by a provider launcher exports the already-synced marker;
  // inherited here it would make every --pull a no-op.
  const { CC_CONFIG_STARTUP_SYNCED: _launcherMarker, ...env } = process.env;
  const raw = execFileSync(process.execPath, [path.join(HERE, 'sync-hook.js'), mode], {
    cwd: repo, encoding: 'utf8', input: JSON.stringify(payload),
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, CODEX_HOME: path.join(TEST_HOME, '.codex'), CLAUDE_SYNC_DIR: '',
      ...IDENT, CLAUDE_SYNC_REPO: repo, ...extraEnv },
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

test('integration: conflicting dirty work is preserved and blocks the update', () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(a, 'shared.txt'), 'base\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'base file');
  git(a, 'push', '--quiet');
  runHook(b, '--pull', { source: 'startup' });

  fs.writeFileSync(path.join(b, 'shared.txt'), 'local uncommitted work\n');
  fs.writeFileSync(path.join(a, 'shared.txt'), 'upstream work\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'upstream edit');
  git(a, 'push', '--quiet');

  const before = git(b, 'rev-parse', 'HEAD');
  const notice = runHook(b, '--pull', { source: 'startup' });
  assert.match(notice, /not updated: 1 local change.*1 commit.*behind/);
  assert.equal(git(b, 'rev-parse', 'HEAD'), before);
  assert.equal(readText(path.join(b, 'shared.txt')), 'local uncommitted work\n');
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
  const root = tempDir('sync-hook-offline-');
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

test('integration: non-conflicting local edits also keep the tree where it is', () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(a, 'mine.txt'), 'base\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'base');
  git(a, 'push', '--quiet');
  runHook(b, '--pull', { source: 'startup' });

  fs.writeFileSync(path.join(b, 'mine.txt'), 'local edit\n');
  fs.writeFileSync(path.join(a, 'other.txt'), 'upstream\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'other');
  git(a, 'push', '--quiet');

  assert.match(runHook(b, '--pull', { source: 'startup' }), /local change\(s\).*pull --ff-only/);
  assert.ok(!fs.existsSync(path.join(b, 'other.txt')), 'upstream must not be applied over local work');
  assert.equal(readText(path.join(b, 'mine.txt')), 'local edit\n');
});

test('integration: an untracked file alone does not block the update', () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(b, 'scratch.txt'), 'wip\n');
  fs.writeFileSync(path.join(a, 'from-a.txt'), 'hello\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'from a');
  git(a, 'push', '--quiet');
  assert.match(runHook(b, '--pull', { source: 'startup' }), /fast-forwarded 1 commit/);
});



// A home with no provider cache: the post-pull refresh must fail loudly there, never touch the real one.
function tempHome() {
  const home = tempDir('sync-hook-home-');
  return { HOME: home, USERPROFILE: home };
}

// A hook that hands the update off starts the real detached `--deps` run: it sits in the clone, makes its worktree
// and uv's lock under the temp root, and records its outcome in the home. Its env gets a private temp root, and the
// test waits for that record, so the run is over before the clone is reclaimed (Windows cannot remove a directory
// a live process sits in).
function handOffEnv() {
  const tmp = tempDir('sync-hook-deps-');
  return { ...tempHome(), TMP: tmp, TEMP: tmp, TMPDIR: tmp };
}

/** The outcome the detached run started at or after `t0` recorded: its error, or null once it cleared its record. */
async function handOffOutcome(home, t0) {
  const file = path.join(home, '.claude', 'own-env-update.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  let started = false;
  for (const deadline = Date.now() + 60_000; ;) {
    const state = read();
    if (state?.pid && state.at >= t0) started = true;
    if (state?.error && state.at >= t0) return state.error;
    if (started && !state) return null;
    if (Date.now() > deadline) throw new Error(`the detached dependency update recorded no outcome: ${JSON.stringify(state)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}


test('integration: only a dependency change asks for a venv sync', () => {
  const { a, b } = fixture();
  const base = git(b, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(a, 'code.py'), 'x = 1\n');
  git(a, 'add', '.'); git(a, 'commit', '--quiet', '-m', 'code'); git(a, 'push', '--quiet');
  const code = git(a, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(a, 'uv.lock'), 'lock\n');
  git(a, 'add', '.'); git(a, 'commit', '--quiet', '-m', 'lock'); git(a, 'push', '--quiet');
  const lock = git(a, 'rev-parse', 'HEAD');
  git(b, 'fetch', '--quiet');
  assert.equal(depsChanged(b, `${base}..${code}`), false);
  assert.equal(depsChanged(b, `${code}..${lock}`), true);
});



// The race this order exists for: a launch starts Python from the tree while the detached update
// runs. The venv must already hold the new dependencies by the time the tree carries new code.
test('integration: a dependency update fills the venv before it moves the tree', async () => {
  const lab = fixture();
  fs.writeFileSync(path.join(lab.a, 'uv.lock'), 'lock v2\n');
  git(lab.a, 'add', '.'); git(lab.a, 'commit', '--quiet', '-m', 'relock'); git(lab.a, 'push', '--quiet');
  const before = git(lab.b, 'rev-parse', 'HEAD');
  const target = git(lab.a, 'rev-parse', 'HEAD');
  const calls = [];
  const uv = (args, { cwd, env }) => calls.push({
    args, cwd, venv: env.UV_PROJECT_ENVIRONMENT, liveHead: git(lab.b, 'rev-parse', 'HEAD'),
    lock: fs.readFileSync(path.join(cwd, 'uv.lock'), 'utf8'),
  });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, tempHome());
  try {
    assert.equal(await updateOwnDeps(lab.b, { uv, refresh: async () => null }), null);
    assert.equal(fs.existsSync(venvStateFile()), false, 'a success clears the state record');
  } finally { Object.assign(process.env, saved); }
  assert.equal(calls.length, 2);
  const [deps, settle] = calls;
  assert.equal(deps.liveHead, before, 'deps installed while the live tree is still the old one');
  assert.equal(deps.lock.trim(), 'lock v2', 'from the target revision\'s lock');
  assert.equal(deps.venv, path.join(lab.b, '.venv'), 'into the live venv');
  assert.ok(deps.args.includes('--inexact') && deps.args.includes('--no-install-project'));
  assert.equal(settle.liveHead, target);
  assert.equal(settle.cwd, lab.b);
  assert.equal(git(lab.b, 'worktree', 'list').split('\n').length, 1, 'temporary worktree removed');
});

test('integration: a failed dependency install leaves the tree where it was', async () => {
  const lab = fixture();
  fs.writeFileSync(path.join(lab.a, 'uv.lock'), 'lock v2\n');
  git(lab.a, 'add', '.'); git(lab.a, 'commit', '--quiet', '-m', 'relock'); git(lab.a, 'push', '--quiet');
  const before = git(lab.b, 'rev-parse', 'HEAD');
  const uv = () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); };
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, tempHome());
  try {
    assert.match(await updateOwnDeps(lab.b, { uv, refresh: async () => null }), /uv sync of \w+ failed \(ENOENT\)/);
    assert.match(JSON.parse(fs.readFileSync(venvStateFile(), 'utf8')).error, /ENOENT/, 'recorded for the retry');
  } finally { Object.assign(process.env, saved); }
  assert.equal(git(lab.b, 'rev-parse', 'HEAD'), before);
});

test('integration: a launch fetches both repos at once, then merges what each fetched', async () => {
  const { fetchRepo, pullRepo } = await import('./sync-hook.js');
  const { a, b, root } = fixture();
  git(a, 'commit', '--allow-empty', '--quiet', '-m', 'next'); git(a, 'push', '--quiet');
  assert.deepEqual(await Promise.all([fetchRepo(b), fetchRepo(path.join(root, 'nowhere'))]), [true, false]);
  assert.equal(await pullRepo(b, { fetched: false }), null, 'a failed fetch is offline: nothing to do');
  assert.equal((await pullRepo(b, { fetched: true })).pulled, 1, 'the earlier fetch is what is merged');
});

test('parseBranchStatus reads dirty count, upstream and ahead from one porcelain v2 status', () => {
  const out = '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +5 -2\n1 .M N... 100644 100644 100644 a b f.js\n? output/\n';
  assert.deepEqual(parseBranchStatus(out), { dirty: 2, upstream: true, ahead: 5 });
  assert.deepEqual(parseBranchStatus('# branch.oid abc\n# branch.head main\n'), { dirty: 0, upstream: false, ahead: 0 });
});

test('integration: the SessionStart mode returns at once and the detached pull still lands', async () => {
  const { a, b } = fixture();
  fs.writeFileSync(path.join(a, 'from-a.txt'), 'bg\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'from a');
  git(a, 'push', '--quiet');
  const tmp = tempDir('sync-hook-bg-');
  const t0 = Date.now();
  const notice = runHook(b, '--pull-background', { source: 'startup' }, { TMP: tmp, TEMP: tmp, TMPDIR: tmp });
  assert.ok(Date.now() - t0 < 10_000, 'the hook returned without waiting on the network');
  const [, log] = notice.match(/^cc-config sync started in the background \(result: (.+)\)$/) ?? [];
  assert.ok(log, notice);
  assert.doesNotMatch(notice, /\n/, 'one line');
  assert.equal(path.dirname(log), tmp, 'the result lands under the temp root the hook was given');
  // The detached pull writes its JSON result last; waiting for it means the child no longer holds the fixture
  // (Windows cannot remove a directory a live process sits in) and the run reclaims every temp dir.
  const finished = () => { try { JSON.parse(fs.readFileSync(log, 'utf8')); return true; } catch { return false; } };
  const deadline = Date.now() + 60_000;
  while (!finished() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.ok(finished(), 'the detached pull wrote its result');
  assert.equal(readText(path.join(b, 'from-a.txt')), 'bg\n', 'the detached pull fast-forwarded');
});

test('the SessionStart mode is silent off startup (resume, clear, compact)', () => {
  const { b } = fixture();
  assert.equal(runHook(b, '--pull-background', { source: 'resume' }), null);
});

test('SessionStart runs the sync hook in the background mode with a short bound', async () => {
  const { STEPS } = await import('./claude-hook.mjs');
  const steps = STEPS.SessionStart.filter((s) => s.script === 'hooks/sync-hook.js');
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].args, ['--pull-background']);
  assert.ok(steps[0].budgetMs <= 10000, 'a session never waits long on the sync hook');
});

// 2026-11-22: ai-lab was a second checkout this hook pulled, because cc-config borrowed its environment. cc-config
// now owns its environment (scripts/shared/own-python.mjs), so a lock change in cc-config itself is the update.
test('integration: a dependency change leaves cc-config where it is and hands the update off', async () => {
  const cfg = fixture();
  fs.writeFileSync(path.join(cfg.a, 'uv.lock'), 'lock\n');
  git(cfg.a, 'add', '.'); git(cfg.a, 'commit', '--quiet', '-m', 'relock'); git(cfg.a, 'push', '--quiet');
  const before = git(cfg.b, 'rev-parse', 'HEAD');
  const env = handOffEnv();
  const t0 = Date.now();
  const notice = runHook(cfg.b, '--pull', { source: 'startup' }, env);
  assert.match(notice, /not updated: the update changes its dependencies; updating in the background/);
  assert.equal(git(cfg.b, 'rev-parse', 'HEAD'), before, 'tree, venv and cache stay consistent until the detached run');
  await handOffOutcome(env.HOME, t0);
});

test('integration: a failed background update is reported and retried, a running one is not doubled', async () => {
  const cfg = fixture();
  const env = handOffEnv();
  const state = path.join(env.HOME, '.claude', 'own-env-update.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ pid: 1, at: Date.now() }));
  assert.match(runHook(cfg.b, '--pull', { source: 'startup' }, env), /still running in the background/);
  fs.writeFileSync(state, JSON.stringify({ error: 'uv sync failed (ENOENT)', at: Date.now() - 1 }));
  const t0 = Date.now();
  assert.match(runHook(cfg.b, '--pull', { source: 'startup' }, env), /last dependency update failed: uv sync failed \(ENOENT\); updating in the background/);
  await handOffOutcome(env.HOME, t0);
});
