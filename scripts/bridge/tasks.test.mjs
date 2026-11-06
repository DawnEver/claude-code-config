import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskBoard, ENDED_KEEP_MS } from './tasks.mjs';
import { TASK_LABEL_MAX, MAX_TASKS } from '../dashboard/public/shared/vocab.mjs';

test('a task runs from its start to its end; the list is running first, then the recently ended', () => {
  const b = new TaskBoard();
  b.start('t1', { kind: 'shell', label: 'npm test', at: 1000 });
  b.start('t2', { kind: 'agent', label: 'Explore: find the hooks', at: 2000, background: true });
  b.end('t1', { status: 'failed', at: 5000 });
  assert.deepEqual(b.list(6000), [
    { id: 't2', kind: 'agent', label: 'Explore: find the hooks', background: true, status: 'running', startedAt: 2000, endedAt: null },
    { id: 't1', kind: 'shell', label: 'npm test', background: false, status: 'failed', startedAt: 1000, endedAt: 5000 }]);
  assert.deepEqual(b.list(5000 + ENDED_KEEP_MS + 1).map((t) => t.id), ['t2'], 'an ended task is listed for a while, then dropped');
});

test('async hooks may arrive out of order: an end before its start, a start again, an end again — the first end stands', () => {
  const b = new TaskBoard();
  b.end('t1', { status: 'completed', at: 3000 });
  b.start('t1', { kind: 'shell', label: 'ls', at: 1000 });
  b.end('t1', { status: 'failed', at: 4000 });
  const [t] = b.list(3000);
  assert.deepEqual([t.status, t.startedAt, t.endedAt, t.label], ['completed', 1000, 3000, 'ls']);
});

test('labels are cut to LABEL_MAX characters on one line', () => {
  const b = new TaskBoard();
  b.start('t', { kind: 'shell', label: `echo a\n  && ${'x'.repeat(500)}`, at: 1 });
  const [t] = b.list(1);
  assert.equal(t.label.length, TASK_LABEL_MAX);
  assert.ok(t.label.startsWith('echo a && xx'));
});

test('background tasks still open are what the transcript says: any other running background task has ended', () => {
  const b = new TaskBoard();
  b.start('u1', { kind: 'shell', label: 'npm run dev', at: 1, background: true });
  b.start('u2', { kind: 'agent', label: 'review', at: 2, background: true });
  b.start('u3', { kind: 'shell', label: 'ls', at: 3 });
  b.settleBackground(['u2'], 10);
  assert.deepEqual(b.list(10).map((t) => [t.id, t.status]), [['u2', 'running'], ['u3', 'running'], ['u1', 'completed']]);
});

test('a turn end ends every foreground task still running: its end was lost, it cannot outlive the turn', () => {
  const b = new TaskBoard();
  b.start('f1', { kind: 'shell', label: 'npm test', at: 1 });
  b.start('g1', { kind: 'shell', label: 'npm run dev', at: 2, background: true });
  b.settleForeground(10);
  assert.deepEqual(b.list(10).map((t) => [t.id, t.status, t.endedAt]), [['g1', 'running', null], ['f1', 'completed', 10]]);
  b.start('late', { kind: 'shell', label: 'ls', at: 8 });
  b.start('next', { kind: 'shell', label: 'pwd', at: 12 });
  assert.deepEqual(b.list(12).filter((t) => ['late', 'next'].includes(t.id)).map((t) => [t.id, t.status]), [['next', 'running'], ['late', 'completed']],
    'a start stamped before the turn end arrived late: that turn ended it');
});

test('a shell is labelled by what it does: its description, else the command without its leading cd and with ~ for home', () => {
  const b = new TaskBoard();
  b.start('d', { kind: 'shell', label: 'Run the unit tests', at: 1 });
  b.start('c', { kind: 'shell', label: 'cd C:/Users/someone/Documents/repo/.claude/worktrees/x && git status && ls', at: 2 });
  b.start('q', { kind: 'shell', label: 'cd "/home/someone/my repo"; cd sub && python -m pytest /home/someone/my repo/tests', at: 3 });
  b.start('p', { kind: 'shell', label: 'cat /c/Users/someone/notes.md', at: 4 });
  assert.deepEqual(b.list(5).map((t) => t.label), ['Run the unit tests', 'git status && ls', 'python -m pytest ~/my repo/tests', 'cat ~/notes.md']);
});

test('closing a session ends everything it ran; the list is bounded', () => {
  const b = new TaskBoard();
  for (let i = 0; i < MAX_TASKS + 10; i++) b.start(`t${i}`, { kind: 'shell', label: String(i), at: i });
  assert.equal(b.list(100).length, MAX_TASKS);
  b.endAll('stopped', 200);
  assert.ok(b.list(200).every((t) => t.status === 'stopped' && t.endedAt === 200));
});
