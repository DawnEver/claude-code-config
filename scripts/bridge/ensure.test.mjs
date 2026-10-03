import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireDaemonLock, ensureDaemon } from './ensure.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ensure-'));

test('lock admits one live owner, takes over a dead one, releases only its own', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'daemon.lock');
    const alive = (pid) => pid === 1;
    const stale = () => false;
    const release = acquireDaemonLock(file, { pid: 1, alive, stale });
    assert.ok(release);
    assert.equal(acquireDaemonLock(file, { pid: 2, alive, stale }), null, 'second live daemon refused');
    const takeover = acquireDaemonLock(file, { pid: 3, alive: () => false });
    assert.ok(takeover, 'dead owner taken over');
    release();
    assert.equal(fs.readFileSync(file, 'utf8'), '3', 'stale release must not drop the new owner');
    takeover();
    assert.equal(fs.existsSync(file), false);
    acquireDaemonLock(file, { pid: 1, alive, stale });
    const reboot = acquireDaemonLock(file, { pid: 4, alive: () => true, stale: () => true });
    assert.ok(reboot, 'a pre-boot lock is stale even if its pid was reused');
    reboot();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensure is a no-op when current, starts when absent, replaces stale source', async () => {
  const dir = tmp();
  try {
    const runtimeFile = path.join(dir, 'runtime.json');
    const calls = [];
    let live = new Set();
    const opts = { runtimeFile, configured: () => true, revision: () => 'new', alive: (p) => live.has(p), stale: () => false,
      kill: (p) => { calls.push(['kill', p]); live.delete(p); }, start: () => calls.push(['start']), sleep: async () => {} };

    assert.equal(await ensureDaemon(opts), 'started');
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 7, sourceRevision: 'new' }));
    live = new Set([7]);
    assert.equal(await ensureDaemon(opts), 'running');
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 7, sourceRevision: 'old' }));
    assert.equal(await ensureDaemon(opts), 'restarted');
    assert.deepEqual(calls, [['start'], ['kill', 7], ['start']]);
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 9, sourceRevision: 'new' }));
    assert.equal(await ensureDaemon(opts), 'started', 'dead pid in runtime file');
    live = new Set([9]);
    assert.equal(await ensureDaemon({ ...opts, stale: () => true }), 'started', 'pid reused after reboot');
    assert.equal(await ensureDaemon({ ...opts, configured: () => false }), 'unconfigured');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
