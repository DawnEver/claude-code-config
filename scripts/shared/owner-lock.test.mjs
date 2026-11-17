// owner-lock.test.mjs — a lock is held only by a live owner: a dead owner's is taken over at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireOwnerLock, ownerLockLive } from './owner-lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lock-'));
// A pid that WAS a process and is now dead: a child that already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;

test('a dead owner\'s lock is taken over at once; a live owner\'s is respected', () => {
  const dir = tmp();
  const file = path.join(dir, 'job.lock');
  try {
    fs.writeFileSync(file, String(process.ppid));   // the test runner: alive
    assert.equal(ownerLockLive(file), true);
    assert.equal(acquireOwnerLock(file, { pid: 999_999_1 }), null, 'PLANTED CONTROL: a live owner keeps its lock');
    fs.writeFileSync(file, String(deadPid()));
    assert.equal(ownerLockLive(file), false, 'an owner killed with its tree holds nothing');
    const release = acquireOwnerLock(file, { pid: 4242 });
    assert.equal(typeof release, 'function', 'taken over at once, no lease to wait out');
    assert.equal(fs.readFileSync(file, 'utf8'), '4242', 'the lock names its new owner');
    release();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a torn, pre-boot or over-age lock is not live; release leaves another owner\'s lock alone', () => {
  const dir = tmp();
  const file = path.join(dir, 'job.lock');
  try {
    fs.writeFileSync(file, 'not a pid');
    assert.equal(ownerLockLive(file), false);
    fs.writeFileSync(file, String(process.pid));
    assert.equal(ownerLockLive(file, { stale: () => true }), false, 'a pid from before this boot');
    assert.equal(ownerLockLive(file, { maxAgeMs: 0 }), false, 'a live owner past maxAgeMs');
    const release = acquireOwnerLock(file, { pid: 1, maxAgeMs: 0 });
    fs.writeFileSync(file, '2');
    release();
    assert.equal(fs.readFileSync(file, 'utf8'), '2', 'a release never removes a lock it no longer owns');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
