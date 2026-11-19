import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgyInvocation } from './agy-launcher.mjs';

test('provenance env tags agy and args pass through', () => {
  const { env, args } = buildAgyInvocation({ extraArgs: ['-p', 'a prompt'], env: { PATH: 'x' }, machine: 'WS9', gitUserName: 'Ann' });
  assert.deepEqual(args, ['-p', 'a prompt']);
  assert.equal(env.HARNESS_MACHINE, 'WS9');
  assert.equal(env.HARNESS_AGENT, 'agy');
  assert.equal(env.GIT_COMMITTER_NAME, 'Ann (WS9/agy)');
  assert.equal(env.PATH, 'x');
});

test('no machine name -> no provenance', () => {
  const { env } = buildAgyInvocation({ env: {}, machine: null, gitUserName: null });
  assert.equal(env.HARNESS_AGENT, undefined);
});
