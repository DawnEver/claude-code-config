import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { liveVersions, staleVersions, prune } from './prune-cache-hook.js';

test('liveVersions reads Windows and POSIX command lines, quoted or not', () => {
  const live = liveVersions([
    'node C:/Users/u/.claude/plugins/cache/cc-market/fabric/0.2.20/scripts/mcp-server.mjs',
    '"C:\\Users\\u\\.claude\\plugins\\cache\\cc-market\\rem\\1.1.23\\hooks\\x.js"',
    'node /home/u/.codex/plugins/cache/mp/watch/2.0.0',
    'node /x/cache/mp/p/1.2.3.4/y.js',
  ].join('\n'));
  assert.deepEqual([...live].sort(), ['cc-market/fabric/0.2.20', 'cc-market/rem/1.1.23', 'mp/watch/2.0.0']);
});

test('staleVersions keeps the numerically latest and live versions, ignores non-versions', () => {
  assert.deepEqual(staleVersions(['0.2.9', '0.2.10', '0.2.8', 'tmp'], () => false), ['0.2.8', '0.2.9']);
  assert.deepEqual(staleVersions(['0.2.9', '0.2.10', '0.2.8'], (v) => v === '0.2.8'), ['0.2.9']);
  assert.deepEqual(staleVersions(['1.0.0'], () => false), []);
  assert.deepEqual(staleVersions([], () => false), []);
});

function cache() {
  const root = join(mkdtempSync(join(tmpdir(), 'prune-')), 'cache');
  for (const v of ['0.2.19', '0.2.20', '0.2.21']) {
    mkdirSync(join(root, 'mp', 'fabric', v, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'mp', 'fabric', v, 'scripts', 'a.mjs'), '');
  }
  mkdirSync(join(root, 'mp', 'solo', '1.0.0'), { recursive: true });
  return root;
}

test('prune deletes stale versions but never one a live process references', () => {
  const root = cache();
  try {
    const removed = prune({ roots: [root], scan: () => `node ${root}/mp/fabric/0.2.20/scripts/mcp-server.mjs`, log: () => {} });
    assert.equal(removed, 1);
    assert.equal(existsSync(join(root, 'mp', 'fabric', '0.2.19')), false);
    assert.ok(existsSync(join(root, 'mp', 'fabric', '0.2.20')), 'live version kept');
    assert.ok(existsSync(join(root, 'mp', 'fabric', '0.2.21')), 'latest kept');
  } finally { rmSync(join(root, '..'), { recursive: true, force: true }); }
});

test('a failed process scan deletes nothing; nothing stale means no scan', () => {
  const root = cache();
  try {
    const logs = [];
    assert.equal(prune({ roots: [root], scan: () => { throw new Error('ETIMEDOUT'); }, log: (m) => logs.push(m) }), 0);
    assert.ok(existsSync(join(root, 'mp', 'fabric', '0.2.19')));
    assert.match(logs[0], /scan failed, nothing pruned/);
    rmSync(join(root, 'mp', 'fabric', '0.2.19'), { recursive: true });
    rmSync(join(root, 'mp', 'fabric', '0.2.20'), { recursive: true });
    assert.equal(prune({ roots: [root], scan: () => assert.fail('scanned with nothing stale'), log: () => {} }), 0);
  } finally { rmSync(join(root, '..'), { recursive: true, force: true }); }
});
