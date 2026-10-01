import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TopicCache } from './topic-cache.mjs';

const H = 3600000;

test('loads both entry shapes, persists, and selects only own closed Topics past the age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const file = path.join(dir, 'topics.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ '-1|codex:old': 9, '-1|codex:open': { topicId: 10 }, '-1|claude:x': { topicId: 11, closedAt: 0 } }));
    const c = new TopicCache(file);
    assert.deepEqual(c.get('-1|codex:old'), { topicId: 9 });
    assert.equal(c.topicId('-1|claude:x'), 11);
    assert.equal(c.get('nope'), null);
    assert.equal(TopicCache.chatIdOf(TopicCache.key(-100, 'claude:a|b')), -100);
    assert.deepEqual(c.due(23 * H, 24), []);
    assert.deepEqual(c.due(24 * H, 24), [['-1|claude:x', { topicId: 11, closedAt: 0 }]]);
    assert.deepEqual(c.due(1000 * H, 0), [], '0 = never');
    c.delete('-1|claude:x');
    c.set('-1|codex:new', { topicId: 12, closedAt: 5 });
    assert.deepEqual(new TopicCache(file).entries, { '-1|codex:old': 9, '-1|codex:open': { topicId: 10 }, '-1|codex:new': { topicId: 12, closedAt: 5 } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing or corrupt file is an empty cache; no file means memory only', () => {
  assert.deepEqual(new TopicCache(path.join(os.tmpdir(), 'nope-topics.json')).entries, {});
  const c = new TopicCache(null);
  c.set('a|b', { topicId: 1 });
  assert.equal(c.topicId('a|b'), 1);
});
