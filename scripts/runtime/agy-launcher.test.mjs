import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgyInvocation, resolveAgySpawn } from './agy-launcher.mjs';

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

test('ai-lab session launcher is used when it runs agy', () => {
  const run = resolveAgySpawn(['x'], { A: '1' }, { sessionSpawn: (agent, args) => ({ command: 'py', args: ['-m', 'ai_lab.session', agent, ...args] }) });
  assert.deepEqual([run.command, ...run.args], ['py', '-m', 'ai_lab.session', 'agy', 'x']);
  assert.equal(run.env.LAB_SESSION, undefined);
});

test('falls back to agy directly with a lab session when ai-lab refuses agy', () => {
  const refuse = () => ({ error: 'ai_lab.session runs claude or codex, not agy' });
  const fresh = resolveAgySpawn(['x'], {}, { sessionSpawn: refuse, uuid: () => 'u-1' });
  assert.deepEqual([fresh.command, ...fresh.args], ['agy', 'x']);
  assert.equal(fresh.env.LAB_SESSION, 'u-1');
  assert.match(fresh.notice, /running agy directly/);
  assert.equal(resolveAgySpawn([], { LAB_SESSION: 'keep' }, { sessionSpawn: refuse }).env.LAB_SESSION, 'keep');
});
