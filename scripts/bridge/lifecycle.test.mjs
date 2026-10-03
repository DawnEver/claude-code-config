import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, onActivity, onIdleTick, onDown, onTopicGone, onTopicFoundClosed, cacheEntry } from './lifecycle.mjs';

const M = 60000;

// One table, run for both hosts: the lifecycle has no host-specific branch.
const steps = [
  // [label, op, args, expected actions, expected state]
  ['first activity opens a Topic', 'activity', { t: 0 }, ['create'], 'open'],
  ['activity on an open Topic does nothing', 'activity', { t: 10 * M }, [], 'open'],
  ['29m idle: still open', 'tick', { t: 39 * M }, [], 'open'],
  ['30m idle: closed quietly', 'tick', { t: 40 * M }, ['close'], 'closed'],
  ['a second tick does not close twice', 'tick', { t: 90 * M }, [], 'closed'],
  ['activity reopens the same Topic', 'activity', { t: 100 * M }, ['reopen'], 'open'],
  ['down closes quietly', 'down', { t: 110 * M }, ['close'], 'ended'],
  ['nothing happens after the end', 'activity', { t: 120 * M }, [], 'ended'],
];

for (const agent of ['codex', 'claude']) {
  test(`lifecycle table (${agent})`, () => {
    const s = newSession({ key: `${agent}:x`, cached: null, now: 0 });
    for (const [label, op, a, actions, state] of steps) {
      let got;
      if (op === 'activity') got = onActivity(s, a.t);
      if (op === 'tick') got = onIdleTick(s, a.t, 30);
      if (op === 'down') got = onDown(s, a.t);
      if (op === 'activity' && got.includes('create')) s.topicId = 7;   // the daemon fills this in
      assert.deepEqual([got, s.state], [actions, state], label);
    }
    assert.deepEqual(cacheEntry(s, 'T'), { topicId: 7, title: 'T', closedAt: 110 * M });
  });
}

test('closedAt is recorded on close and cleared on reopen', () => {
  const s = newSession({ key: 'k', cached: null, now: 0 });
  onActivity(s, 0); s.topicId = 1;
  onIdleTick(s, 30 * M, 30);
  assert.equal(s.closedAt, 30 * M);
  assert.deepEqual(cacheEntry(s, 'T'), { topicId: 1, title: 'T', closedAt: 30 * M });
  onActivity(s, 31 * M);
  assert.equal(s.closedAt, null);
  assert.deepEqual(cacheEntry(s, 'T'), { topicId: 1, title: 'T' });
});

test('a session without activity has no Topic, is never idle-closed and ends silently', () => {
  const s = newSession({ key: 'k', cached: null, now: 0 });
  assert.equal(s.state, 'none');
  assert.deepEqual(onIdleTick(s, 1000 * M, 30), []);
  assert.deepEqual(onDown(s, 1000 * M), []);
  const t = newSession({ key: 'k2', cached: null, now: 0 });
  assert.deepEqual(onActivity(t, 5 * M), ['create']);
});

test('a cached Topic is re-attached in the state the cache recorded', () => {
  const open = newSession({ key: 'k', cached: { topicId: 5 }, now: 0 });
  assert.deepEqual([open.state, open.topicId], ['open', 5]);
  assert.deepEqual(onActivity(open, 1), [], 'resume: same Topic, nothing to announce');
  const closed = newSession({ key: 'k', cached: { topicId: 5, closedAt: 3 }, now: 0 });
  assert.equal(closed.state, 'closed', 'a closed Topic stays closed until activity');
  assert.deepEqual(onActivity(closed, 10), ['reopen']);
  assert.equal(closed.topicId, 5, 'never a new Topic for the same session');
});

test('down on an open session without a Topic does nothing', () => {
  const s = newSession({ key: 'k', cached: null, now: 0 });
  onActivity(s, 0);
  assert.deepEqual(onDown(s, 1), []);
});

test('a down on an idle-closed Topic stays quiet; idle 0 means never', () => {
  const s = newSession({ key: 'k', cached: { topicId: 5 }, now: 0 });
  assert.deepEqual(onIdleTick(s, 1000 * M, 0), []);
  onIdleTick(s, 30 * M, 30);
  assert.deepEqual(onDown(s, 40 * M), []);
  assert.equal(s.closedAt, 30 * M);
});

test('Telegram-side drift: a deleted Topic is recreated, a closed one reopened', () => {
  const s = newSession({ key: 'k', cached: { topicId: 5 }, now: 0 });
  assert.deepEqual(onTopicGone(s), ['create']);
  assert.deepEqual([s.topicId, s.state], [null, 'open']);
  const c = newSession({ key: 'k', cached: { topicId: 5 }, now: 0 });
  assert.deepEqual(onTopicFoundClosed(c), ['reopen']);
  assert.equal(c.state, 'open');
});

test('a session found not to be a main session has its open Topic closed quietly', () => {
  const s = newSession({ key: 'k', cached: { topicId: 5 }, now: 0 });
  assert.deepEqual(onDown(s, 7), ['close']);
  assert.deepEqual([s.state, s.closedAt], ['ended', 7]);
  const closed = newSession({ key: 'k', cached: { topicId: 5, closedAt: 3 }, now: 0 });
  assert.deepEqual(onDown(closed, 7), []);
  assert.equal(closed.closedAt, 3);
});
