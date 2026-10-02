import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestClaude } from './process-tree.mjs';

test('nearestClaude: the first claude CLI above a pid, skipping shells and shims', () => {
  const table = new Map([
    [30, { ppid: 20, cmd: 'node hook.js' }],
    [20, { ppid: 10, cmd: 'bash -c node hook.js' }],
    [10, { ppid: 5, cmd: '"C:/tools/claude.exe" --resume' }],
    [5, { ppid: 1, cmd: 'claude' }],
  ]);
  assert.equal(nearestClaude(30, table), 10);
  assert.equal(nearestClaude(99, table), null);
});
