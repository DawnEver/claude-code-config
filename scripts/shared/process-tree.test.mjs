import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestClaude, parseTable, processTable } from './process-tree.mjs';

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

test('parseTable reads both shapes: PowerShell\'s tab-separated lines and ps\'s padded columns', () => {
  const win = '0\t0\tSystem Idle Process\r\n4\t0\tSystem\r\n7120\t4\t"C:\\tools\\claude.exe" --resume 12\r\n9\t7120\tnode  hook.js  3\r\n';
  assert.deepEqual([...parseTable(win, { ps: false }).keys()], [0, 4, 7120, 9], 'every PowerShell line');
  assert.equal(parseTable(win, { ps: false }).get(9).cmd, 'node  hook.js  3', 'a command keeps its own spacing');
  const ps = '    1     0 /sbin/init\n  812     1 claude --resume\n  900   812 node hook.js\n';
  assert.deepEqual([...parseTable(ps, { ps: true }).entries()], [[1, { ppid: 0, cmd: '/sbin/init' }], [812, { ppid: 1, cmd: 'claude --resume' }], [900, { ppid: 812, cmd: 'node hook.js' }]]);
});

test('the live table holds this process and its parent', () => {
  const table = processTable();
  assert.ok(table.size > 2, `PLANTED CONTROL: a real machine runs more than ${table.size} processes`);
  assert.equal(table.get(process.pid)?.ppid, process.ppid, 'this process, with its parent');
});
