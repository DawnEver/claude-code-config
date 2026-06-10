import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findOrphanedLinks, discoverProjectMigrators } from './migrate.js';

describe('findOrphanedLinks', () => {
  let tmpDir, sourceDir, baseDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
    sourceDir = path.join(tmpDir, 'repo');
    baseDir = path.join(tmpDir, 'claude');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'CURRENT.md'), 'current');
    fs.writeFileSync(path.join(sourceDir, 'OLD.md'), 'old');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty when only current links exist', () => {
    fs.symlinkSync(path.join(sourceDir, 'CURRENT.md'), path.join(baseDir, 'CLAUDE.md'));
    const links = [{ src: 'CURRENT.md', dest: 'CLAUDE.md', type: 'file' }];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('detects a top-level symlink no longer in CLAUDE_LINKS', () => {
    fs.symlinkSync(path.join(sourceDir, 'CURRENT.md'), path.join(baseDir, 'CLAUDE.md'));
    fs.symlinkSync(path.join(sourceDir, 'OLD.md'), path.join(baseDir, 'OLD.md'));
    const links = [{ src: 'CURRENT.md', dest: 'CLAUDE.md', type: 'file' }];
    const orphans = findOrphanedLinks({ baseDir, links, sourceDir });
    assert.deepEqual(orphans.map(o => o.rel), ['OLD.md']);
  });

  test('ignores symlinks pointing outside sourceDir', () => {
    const externalDir = path.join(tmpDir, 'external');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'foo.md'), 'foo');
    fs.symlinkSync(path.join(externalDir, 'foo.md'), path.join(baseDir, 'foo.md'));
    const links = [];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('detects orphans nested inside a current container dir', () => {
    fs.mkdirSync(path.join(baseDir, 'plugins', 'claude-hud'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'claude_plugins', 'claude-hud'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'claude_plugins', 'claude-hud', 'config.json'), '{}');
    fs.writeFileSync(path.join(sourceDir, 'claude_plugins', 'claude-hud', 'old-config.json'), '{}');
    fs.symlinkSync(
      path.join(sourceDir, 'claude_plugins', 'claude-hud', 'config.json'),
      path.join(baseDir, 'plugins', 'claude-hud', 'config.json'),
    );
    fs.symlinkSync(
      path.join(sourceDir, 'claude_plugins', 'claude-hud', 'old-config.json'),
      path.join(baseDir, 'plugins', 'claude-hud', 'old-config.json'),
    );
    const links = [{ src: path.join('claude_plugins', 'claude-hud', 'config.json'), dest: 'plugins/claude-hud/config.json', type: 'file' }];
    const orphans = findOrphanedLinks({ baseDir, links, sourceDir });
    assert.deepEqual(orphans.map(o => o.rel), ['plugins/claude-hud/old-config.json']);
  });

  test('does not descend into real (non-symlink, non-container) directories', () => {
    fs.mkdirSync(path.join(baseDir, 'unrelated'), { recursive: true });
    fs.symlinkSync(path.join(sourceDir, 'OLD.md'), path.join(baseDir, 'unrelated', 'nested.md'));
    const links = [];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });
});

describe('discoverProjectMigrators', () => {
  let tmpDir, ccMarketDir;

  function writeMigration(pluginDir) {
    fs.mkdirSync(path.join(pluginDir, 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'migrations', 'migrate.mjs'),
      'export async function migrate() { return { changed: false, summary: [] }; }',
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cc-'));
    ccMarketDir = path.join(tmpDir, 'cc-market');
    fs.mkdirSync(ccMarketDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty when cc-market dir is missing', () => {
    assert.deepEqual(discoverProjectMigrators(path.join(tmpDir, 'nonexistent')), []);
  });

  test('returns empty when cc-market dir has no plugins with migrations', () => {
    fs.mkdirSync(path.join(ccMarketDir, 'takeover'), { recursive: true });
    assert.deepEqual(discoverProjectMigrators(ccMarketDir), []);
  });

  test('discovers plugins that have a migrations/migrate.mjs', () => {
    writeMigration(path.join(ccMarketDir, 'rem'));
    writeMigration(path.join(ccMarketDir, 'sharp-review'));
    fs.mkdirSync(path.join(ccMarketDir, 'takeover'), { recursive: true });
    const migrators = discoverProjectMigrators(ccMarketDir);
    assert.equal(migrators.length, 2);
    const names = migrators.map(m => m.name).sort();
    assert.deepEqual(names, ['rem', 'sharp-review']);
  });

  test('ignores non-directory entries in cc-market', () => {
    fs.writeFileSync(path.join(ccMarketDir, 'README.md'), 'readme');
    writeMigration(path.join(ccMarketDir, 'rem'));
    const migrators = discoverProjectMigrators(ccMarketDir);
    assert.equal(migrators.length, 1);
    assert.equal(migrators[0].name, 'rem');
  });
});
