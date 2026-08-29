import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  expandTilde,
  readSyncDirPointer,
  writeSyncDirPointer,
  resolveSyncDir,
  SYNC_DIR_POINTER_NAME,
} from './sync-dir.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sync-dir-${prefix}-`));
}

// A fake $HOME whose .claude dir we control, so no test ever touches the real one.
function fakeHome() {
  const home = tmp('home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

test('expandTilde: expands a leading ~ against the given home', () => {
  assert.equal(expandTilde('~/Sync/cfg', '/Users/x'), path.join('/Users/x', 'Sync/cfg'));
  assert.equal(expandTilde('~', '/Users/x'), '/Users/x');
});

test('expandTilde: leaves absolute and non-tilde paths alone', () => {
  assert.equal(expandTilde('/abs/path', '/Users/x'), '/abs/path');
  // `~foo` is a USER home reference, not our home — must not be mangled.
  assert.equal(expandTilde('~notme/path', '/Users/x'), '~notme/path');
});

test('resolveSyncDir: defaults to the repo root when nothing is configured', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  // This is the zero-config path for users with no cloud storage: the resolved
  // layout must be byte-identical to the pre-syncDir behaviour.
  assert.equal(resolveSyncDir({ repoRoot, env: {}, home }), repoRoot);
});

test('resolveSyncDir: CLAUDE_SYNC_DIR wins over everything', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const fromEnv = tmp('env');
  const fromPointer = tmp('pointer');
  writeSyncDirPointer(fromPointer, home);

  assert.equal(resolveSyncDir({ repoRoot, env: { CLAUDE_SYNC_DIR: fromEnv }, home }), fromEnv);
});

test('resolveSyncDir: pointer file wins over the repo default', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const payload = tmp('payload');
  writeSyncDirPointer(payload, home);

  assert.equal(resolveSyncDir({ repoRoot, env: {}, home }), payload);
});

test('resolveSyncDir: expands ~ from both the env var and the pointer file', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');

  writeSyncDirPointer('~/Sync/from-pointer', home);
  assert.equal(resolveSyncDir({ repoRoot, env: {}, home }), path.join(home, 'Sync/from-pointer'));

  assert.equal(
    resolveSyncDir({ repoRoot, env: { CLAUDE_SYNC_DIR: '~/Sync/from-env' }, home }),
    path.join(home, 'Sync/from-env'),
  );
});

test('resolveSyncDir: blank or whitespace-only pointer falls through to the repo default', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');

  for (const body of ['', '   ', '\n', '\t\n  ']) {
    fs.writeFileSync(path.join(home, '.claude', SYNC_DIR_POINTER_NAME), body);
    assert.equal(resolveSyncDir({ repoRoot, env: {}, home }), repoRoot, `body: ${JSON.stringify(body)}`);
  }
});

test('resolveSyncDir: blank CLAUDE_SYNC_DIR falls through instead of resolving to cwd', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const payload = tmp('payload');
  writeSyncDirPointer(payload, home);

  // An exported-but-empty env var is a classic shell-profile accident; it must not
  // silently win and resolve to '' (which path.join would turn into the cwd).
  assert.equal(resolveSyncDir({ repoRoot, env: { CLAUDE_SYNC_DIR: '  ' }, home }), payload);
});

test('readSyncDirPointer: returns null when absent', () => {
  const home = fakeHome();
  assert.equal(readSyncDirPointer(home), null);
});

test('readSyncDirPointer: ignores a trailing newline written by an editor', () => {
  const home = fakeHome();
  fs.writeFileSync(path.join(home, '.claude', SYNC_DIR_POINTER_NAME), '/some/payload\n');
  assert.equal(readSyncDirPointer(home), '/some/payload');
});

test('writeSyncDirPointer: creates ~/.claude when it does not exist yet', () => {
  // Bootstrap order: setup may write the pointer before ~/.claude has been populated.
  const home = tmp('bare-home');
  const payload = tmp('payload');
  writeSyncDirPointer(payload, home);
  assert.equal(readSyncDirPointer(home), payload);
});

test('writeSyncDirPointer: is idempotent', () => {
  const home = fakeHome();
  const payload = tmp('payload');
  writeSyncDirPointer(payload, home);
  writeSyncDirPointer(payload, home);
  assert.equal(readSyncDirPointer(home), payload);
});

test('writeSyncDirPointer: overwrites a previous pointer rather than appending', () => {
  const home = fakeHome();
  const a = tmp('a');
  const b = tmp('b');
  writeSyncDirPointer(a, home);
  writeSyncDirPointer(b, home);
  assert.equal(readSyncDirPointer(home), b);
});
