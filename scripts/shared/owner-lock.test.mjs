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
    // Age is measured against an mtime set an hour back: a just-written file's mtime (100 ns on NTFS)
    // can lie ahead of the millisecond-truncated clock, so a 0 ms bound would read it as live. The
    // boot check is held off: a fresh runner may have booted less than an hour ago.
    const never = () => false;
    assert.equal(ownerLockLive(file, { stale: never, maxAgeMs: 60_000 }), true, 'PLANTED CONTROL: a fresh live owner is within maxAgeMs');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(file, anHourAgo, anHourAgo);
    assert.equal(ownerLockLive(file, { stale: never, maxAgeMs: 60_000 }), false, 'a live owner past maxAgeMs');
    const release = acquireOwnerLock(file, { pid: 1, stale: never, maxAgeMs: 60_000 });
    assert.equal(typeof release, 'function', 'an over-age lock is taken over');
    fs.writeFileSync(file, '2');
    release();
    assert.equal(fs.readFileSync(file, 'utf8'), '2', 'a release never removes a lock it no longer owns');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
