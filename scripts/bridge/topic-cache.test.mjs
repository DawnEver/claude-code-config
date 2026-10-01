import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TopicCache } from './topic-cache.mjs';

const H = 3600000;

test('loads valid entries only, persists, and selects closed Topics past the age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const file = path.join(dir, 'topics.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ '-1|codex:old': 9, '-1|codex:open': { topicId: 10, title: 'a' }, '-1|claude:x': { topicId: 11, title: 'b', closedAt: 0 } }));
    const c = new TopicCache(file);
    assert.equal(c.get('-1|codex:old'), null, 'other shapes are ignored');
    assert.equal(c.get('-1|claude:x').topicId, 11);
    assert.equal(TopicCache.chatIdOf(TopicCache.key(-100, 'claude:a|b')), -100);
    assert.deepEqual(c.due(23 * H, 24), []);
    assert.deepEqual(c.due(24 * H, 24).map(([k]) => k), ['-1|claude:x']);
    assert.deepEqual(c.due(1000 * H, 0), [], '0 = never');
    c.set('-1|claude:x', null);
    c.set('-1|codex:new', { topicId: 12, title: 'c', closedAt: 5 });
    assert.deepEqual(Object.keys(new TopicCache(file).entries), ['-1|codex:open', '-1|codex:new']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing or corrupt file is an empty cache; no file means memory only', () => {
  assert.deepEqual(new TopicCache(path.join(os.tmpdir(), 'nope-topics.json')).entries, {});
  const c = new TopicCache(null);
  c.set('a|b', { topicId: 1 });
  assert.equal(c.get('a|b').topicId, 1);
});
