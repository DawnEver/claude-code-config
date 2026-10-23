import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBeforeLaunch } from './startup-sync.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('provider launcher bootstraps do not preload mutable config or home modules before synchronization', () => {
  for (const file of ['cc.js', 'codex.js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const relative = [...source.matchAll(/^import\s+.*?from\s+['"](\.[^'"]+)['"]/gm)].map(m => m[1]);
    assert.deepEqual(relative, ['./startup-sync.mjs'], file);
    assert.ok(source.indexOf('syncBeforeLaunch(') < source.indexOf('await Promise.all'), file);
  }
});

test('wrapper and daemon native startup share a short lease even without shared env', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stampFile = path.join(dir, 'stamp');
  let calls = 0;
  const options = { stampFile, env: {}, spawn: () => { calls++; return { stdout: '{}' }; } };
  syncBeforeLaunch(options);
  assert.equal(syncBeforeLaunch(options).skipped, true);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(`${stampFile}.lock`), false);
});

test('a failed startup spawn releases the lease and fails open', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stampFile = path.join(dir, 'stamp');
  const out = syncBeforeLaunch({ stampFile, env: {}, spawn: () => { throw new Error('offline'); } });
  assert.equal(out.error.message, 'offline');
  assert.equal(fs.existsSync(`${stampFile}.lock`), false);
});

test('startup sync invokes the hook portably without a shell', () => {
  let call;
  const result = syncBeforeLaunch({
    hookPath: '/repo/scripts/hooks/sync-hook.js',
    nodePath: '/node',
    env: { TEST: 'yes' },
    spawn(command, args, options) {
      call = { command, args, options };
      return { stdout: '{"systemMessage":"updated","ccConfigSync":{"pulled":2,"repairError":"busy"}}' };
    },
  });
  assert.deepEqual(call.args, ['/repo/scripts/hooks/sync-hook.js', '--pull']);
  assert.equal(call.command, '/node');
  assert.equal(call.options.input, '{"source":"startup"}');
  assert.equal(call.options.shell, undefined);
  assert.equal(result.notice, 'updated');
  assert.equal(result.pulled, 2);
  assert.equal(result.repairError, 'busy');
});

test('startup sync fails open on process and output failures', () => {
  assert.doesNotThrow(() => syncBeforeLaunch({
    spawn: () => ({ stdout: 'not json', error: new Error('offline') }),
  }));
  assert.equal(syncBeforeLaunch({ spawn: () => ({ stdout: 'not json' }) }).notice, null);
});

test('startup sync marker prevents a second pull in a child host session', () => {
  let called = false;
  const result = syncBeforeLaunch({
    env: { CC_CONFIG_STARTUP_SYNCED: '1' },
    spawn: () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
});
