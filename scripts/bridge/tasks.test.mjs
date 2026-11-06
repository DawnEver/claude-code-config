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

test('closing a session ends everything it ran; the list is bounded', () => {
  const b = new TaskBoard();
  for (let i = 0; i < MAX_TASKS + 10; i++) b.start(`t${i}`, { kind: 'shell', label: String(i), at: i });
  assert.equal(b.list(100).length, MAX_TASKS);
  b.endAll('stopped', 200);
  assert.ok(b.list(200).every((t) => t.status === 'stopped' && t.endedAt === 200));
});
