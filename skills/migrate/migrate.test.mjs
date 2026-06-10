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
  let tmpHome, projectDir, origHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-project-'));
    origHome = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function writeInstalledPlugins(plugins) {
    const dir = path.join(tmpHome, '.claude', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ plugins }));
  }

  function writeMigration(installPath) {
    fs.mkdirSync(path.join(installPath, 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, 'migrations', 'migrate.mjs'),
      'export async function migrate() { return { changed: false, summary: [] }; }',
    );
  }

  test('returns empty when installed_plugins.json is missing', () => {
    assert.deepEqual(discoverProjectMigrators(projectDir), []);
  });

  test('includes user-scoped plugins with a migrations/migrate.mjs', () => {
    const installPath = path.join(tmpHome, 'rem-install');
    writeMigration(installPath);
    writeInstalledPlugins({
      'rem@cc-market': [{ scope: 'user', installPath, version: '1.0.0' }],
    });
    const migrators = discoverProjectMigrators(projectDir);
    assert.deepEqual(migrators, [{ name: 'rem', migratePath: path.join(installPath, 'migrations', 'migrate.mjs') }]);
  });

  test('includes project-scoped plugins only for the matching project', () => {
    const installPath = path.join(tmpHome, 'sr-install');
    writeMigration(installPath);
    writeInstalledPlugins({
      'sharp-review@cc-market': [
        { scope: 'project', projectPath: projectDir, installPath, version: '1.0.0' },
        { scope: 'project', projectPath: '/some/other/project', installPath, version: '1.0.0' },
      ],
    });
    const migrators = discoverProjectMigrators(projectDir);
    assert.equal(migrators.length, 1);
    assert.equal(migrators[0].name, 'sharp-review');
  });

  test('skips plugins without migrations/migrate.mjs', () => {
    const installPath = path.join(tmpHome, 'watch-install');
    fs.mkdirSync(installPath, { recursive: true });
    writeInstalledPlugins({
      'watch@cc-market': [{ scope: 'user', installPath, version: '1.0.0' }],
    });
    assert.deepEqual(discoverProjectMigrators(projectDir), []);
  });

  test('ignores non-cc-market plugin entries', () => {
    const installPath = path.join(tmpHome, 'other-install');
    writeMigration(installPath);
    writeInstalledPlugins({
      'something@other-market': [{ scope: 'user', installPath, version: '1.0.0' }],
    });
    assert.deepEqual(discoverProjectMigrators(projectDir), []);
  });
});
