import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBeforeLaunch } from './startup-sync.mjs';

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
