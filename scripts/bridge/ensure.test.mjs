import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireDaemonLock, daemonRunning, ensureDaemon } from './ensure.mjs';

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
    const opts = { runtimeFile, configured: () => true, revision: () => 'new', configRevision: () => 'cfg', alive: (p) => live.has(p), stale: () => false,
      kill: (p) => { calls.push(['kill', p]); live.delete(p); }, start: () => calls.push(['start']), sleep: async () => {}, log: (m) => calls.push(['log', m]), replace: true };

    assert.equal(await ensureDaemon(opts), 'started');
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 7, sourceRevision: 'new', configRevision: 'cfg' }));
    live = new Set([7]);
    assert.equal(await ensureDaemon(opts), 'running');
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 7, sourceRevision: 'old' }));
    assert.equal(await ensureDaemon(opts), 'restarted');
    assert.deepEqual(calls, [['start'], ['log', 'ensure: replacing daemon 7 (source or config changed)'], ['kill', 7], ['start']]);
    live = new Set([7]);
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 7, sourceRevision: 'new', configRevision: 'old-cfg' }));
    assert.equal(await ensureDaemon(opts), 'restarted', 'a config change replaces the daemon too');
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 9, sourceRevision: 'new' }));
    assert.equal(await ensureDaemon(opts), 'started', 'dead pid in runtime file');
    live = new Set([9]);
    assert.equal(await ensureDaemon({ ...opts, stale: () => true }), 'started', 'pid reused after reboot');
    assert.equal(await ensureDaemon({ ...opts, configured: () => false }), 'unconfigured');
    // Without `replace` (a session start): a changed daemon is left to hand itself over.
    calls.length = 0; live = new Set([9]);
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 9, sourceRevision: 'old', configRevision: 'cfg' }));
    assert.equal(await ensureDaemon({ ...opts, replace: false }), 'stale');
    assert.deepEqual(calls, [], 'never killed by a session start');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a live collector for another Codex home is not silently replaced or attributed to this home', async () => {
  const dir = tmp();
  try {
    const runtimeFile = path.join(dir, 'runtime.json');
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 7, codexHome: path.join(dir, 'one'), sourceRevision: 'old' }));
    const result = await ensureDaemon({ runtimeFile, configured: () => true, codexHome: path.join(dir, 'two'),
      alive: () => true, stale: () => false, kill: () => assert.fail('replaced another home'), start: () => assert.fail('started duplicate collector') });
    assert.equal(result, 'different-home');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('daemonRunning reads only the runtime pid: missing, dead, stale and live', () => {
  const file = path.join(tmp(), 'runtime.json');
  assert.equal(daemonRunning({ runtimeFile: file }), false);
  fs.writeFileSync(file, JSON.stringify({ pid: 42 }));
  assert.equal(daemonRunning({ runtimeFile: file, alive: () => false, stale: () => false }), false);
  assert.equal(daemonRunning({ runtimeFile: file, alive: () => true, stale: () => true }), false);
  assert.equal(daemonRunning({ runtimeFile: file, alive: () => true, stale: () => false }), true);
});
