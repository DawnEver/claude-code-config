import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { liveVersions, staleVersions, prune, pruneOrphans, codexMarketListing } from './prune-cache-hook.js';
import { tempDir } from '../shared/temp-dir.mjs';

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
  const root = join(tempDir('prune-'), 'cache');
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
    const removed = prune({ roots: [root], reportOnly: false, scan: () => `node ${root}/mp/fabric/0.2.20/scripts/mcp-server.mjs`, log: () => {} });
    assert.equal(removed, 1);
    assert.equal(existsSync(join(root, 'mp', 'fabric', '0.2.19')), false);
    assert.ok(existsSync(join(root, 'mp', 'fabric', '0.2.20')), 'live version kept');
    assert.ok(existsSync(join(root, 'mp', 'fabric', '0.2.21')), 'latest kept');
  } finally { rmSync(join(root, '..'), { recursive: true, force: true }); }
});

test('automatic pruning only reports candidates, never deleting unknown lazy-loaded versions', () => {
  const root = cache();
  try {
    const logs = [];
    assert.equal(prune({ roots: [root], scan: () => 'codex app-server --listen unix:// --managed-daemon', log: m => logs.push(m) }), 0);
    assert.ok(existsSync(join(root, 'mp', 'fabric', '0.2.19')));
    assert.ok(logs.some(m => /candidate.*not removed/.test(m)));
    assert.equal(prune({ roots: [root], reportOnly: false, scan: () => 'codex app-server --listen unix://', log: () => {} }), 0);
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

// Orphans: a plugin dir in the cache that no marketplace lists (doctor's codex-plugin-orphan-cache).
function orphanCache() {
  const root = join(tempDir('orphans-'), 'cache');
  for (const name of ['fabric', 'takeover', 'ghost']) {
    mkdirSync(join(root, 'cc-market', name, '1.0.0'), { recursive: true });
    writeFileSync(join(root, 'cc-market', name, '1.0.0', 'a.mjs'), '');
  }
  mkdirSync(join(root, 'other-mp', 'unlisted', '1.0.0'), { recursive: true });
  return root;
}
const listed = { 'cc-market': new Set(['fabric']) };

test('orphans: listed only without --apply; with it the unheld are removed, the held kept and named', () => {
  const root = orphanCache();
  try {
    const logs = [];
    const scan = () => `node ${join(root, 'cc-market', 'ghost', '1.0.0', 'a.mjs')}`;
    assert.deepEqual(pruneOrphans({ root, listed, scan, log: (m) => logs.push(m) }).removed, []);
    assert.ok(existsSync(join(root, 'cc-market', 'takeover')), 'listing never deletes');
    const out = pruneOrphans({ root, listed, scan, apply: true, log: (m) => logs.push(m) });
    assert.deepEqual(out.removed, ['cc-market/takeover']);
    assert.deepEqual(out.kept, ['cc-market/ghost']);
    assert.equal(existsSync(join(root, 'cc-market', 'takeover')), false, 'unheld orphan removed');
    assert.ok(existsSync(join(root, 'cc-market', 'ghost')), 'held orphan kept');
    assert.ok(logs.some((m) => /ghost.*kept.*running process/.test(m)), logs.join('\n'));
    assert.ok(existsSync(join(root, 'cc-market', 'fabric')), 'a listed plugin is never touched');
    assert.ok(existsSync(join(root, 'other-mp', 'unlisted')), 'a marketplace with no known listing is never touched');
  } finally { rmSync(join(root, '..'), { recursive: true, force: true }); }
});

test('orphans: a failed scan or a running Codex app-server deletes nothing', () => {
  const root = orphanCache();
  try {
    const logs = [];
    const failed = pruneOrphans({ root, listed, apply: true, scan: () => { throw new Error('ETIMEDOUT'); }, log: (m) => logs.push(m) });
    assert.deepEqual(failed.removed, []);
    assert.match(logs.join('\n'), /scan failed, nothing removed/);
    const daemon = pruneOrphans({ root, listed, apply: true, scan: () => 'codex app-server --listen unix://', log: (m) => logs.push(m) });
    assert.deepEqual(daemon.removed, []);
    assert.match(logs.join('\n'), /Codex app-server is running/);
    assert.ok(existsSync(join(root, 'cc-market', 'takeover')));
  } finally { rmSync(join(root, '..'), { recursive: true, force: true }); }
});

test('codexMarketListing reads the cc-market Codex manifest; an unreadable one lists nothing to delete', () => {
  const market = tempDir('market-');
  assert.equal(codexMarketListing(market), null);
  mkdirSync(join(market, '.agents', 'plugins'), { recursive: true });
  writeFileSync(join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'fabric' }] }));
  assert.deepEqual([...codexMarketListing(market)['cc-market']], ['fabric']);
  assert.equal(codexMarketListing(null), null);
  rmSync(market, { recursive: true, force: true });
});
