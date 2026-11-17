import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, isClaudeProcess, parseTable, readProcessTable } from './process-tree.mjs';

test('ancestorsOf walks up from a pid; the first claude CLI above it skips shells and shims', () => {
  const table = new Map([
    [30, { ppid: 20, cmd: 'node hook.js' }],
    [20, { ppid: 10, cmd: 'bash -c node hook.js' }],
    [10, { ppid: 5, cmd: '"C:/tools/claude.exe" --resume' }],
    [5, { ppid: 1, cmd: 'claude' }],
  ]);
  assert.equal(ancestorsOf(30, table).find((a) => isClaudeProcess(a.cmd))?.pid, 10);
  assert.deepEqual(ancestorsOf(99, table), []);
});

test('parseTable reads both shapes: PowerShell\'s tab-separated lines and ps\'s padded columns', () => {
  const win = '0\t0\tSystem Idle Process\r\n4\t0\tSystem\r\n7120\t4\t"C:\\tools\\claude.exe" --resume 12\r\n9\t7120\tnode  hook.js  3\r\n';
  assert.deepEqual([...parseTable(win, { ps: false }).keys()], [0, 4, 7120, 9], 'every PowerShell line');
  assert.equal(parseTable(win, { ps: false }).get(9).cmd, 'node  hook.js  3', 'a command keeps its own spacing');
  const ps = '    1     0 /sbin/init\n  812     1 claude --resume\n  900   812 node hook.js\n';
  assert.deepEqual([...parseTable(ps, { ps: true }).entries()], [[1, { ppid: 0, cmd: '/sbin/init' }], [812, { ppid: 1, cmd: 'claude --resume' }], [900, { ppid: 812, cmd: 'node hook.js' }]]);
});

test('a table the OS will not give is named, never an empty table read as "no processes"', () => {
  const node = process.execPath;
  const cases = [
    [{ query: ['no-such-process-query', []] }, /^the process-table query \(no-such-process-query\) is not on PATH$/],
    [{ query: [node, ['-e', 'setTimeout(() => {}, 10000)']], timeoutMs: 300 }, /\) timed out after 300 ms$/],
    [{ query: [node, ['-e', 'process.exit(3)']] }, /\) failed \(exit 3\)$/],
    [{ query: [node, ['-e', '']] }, /\) listed no process$/],
  ];
  for (const [opts, why] of cases) {
    const { table, error } = readProcessTable(opts);
    assert.equal(table.size, 0);
    assert.match(error ?? '', why, `PLANTED CONTROL: ${opts.query[1].join(' ') || opts.query[0]}`);
  }
});

// A cold CIM query on a fresh Windows CI runner under load ran past the old 10 s budget (2026-11-17);
// the channel, its one user, reads it once at start, so it may take its time.
test('the live table holds this process and its parent', () => {
  const { table, error } = readProcessTable({ timeoutMs: 60_000 });
  assert.equal(error, null, `the process table is unavailable here: ${error}`);
  assert.equal(table.get(process.pid)?.ppid, process.ppid, 'this process, with its parent');
});
