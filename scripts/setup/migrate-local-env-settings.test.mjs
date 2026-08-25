// Unit tests for scripts/setup/migrate-local-env-settings.mjs.
//
// Migrates a local settings file from the pre-2026-08-25 `env:<provider>` shape
// to the new `providers.<provider>.apiKey` shape. Each test uses mkdtempSync for
// a temp file; the real ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateLocalEnvSettings } from './migrate-local-env-settings.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-local-'));
  return { path: join(dir, 'claude_env_settings.local.json') };
}

test('no-file: returns no-file when the local path does not exist', () => {
  const { path } = fixture();
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'no-file');
  assert.equal(existsSync(path), false, 'must not create the file');
});

test('current: returns current when the file is already in the new shape', () => {
  const { path } = fixture();
  writeFileSync(path, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-x' } } }));
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'current');
  // File must not be touched
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ providers: { deepseek: { apiKey: 'sk-x' } } }));
});

test('current: returns current when the local file is empty', () => {
  const { path } = fixture();
  writeFileSync(path, '{}');
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'current');
  assert.equal(result.note, 'empty local file');
});

test('malformed: returns malformed with the JSON error when the file is unparseable', () => {
  const { path } = fixture();
  writeFileSync(path, '{ this is not json');
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'malformed');
  assert.match(result.error, /JSON/);
});

test('mixed: returns mixed when both env: and providers: blocks are present (left alone)', () => {
  const { path } = fixture();
  const before = JSON.stringify({
    providers: { deepseek: { apiKey: 'sk-new' }, kimi: { apiKey: 'sk-k' } },
    'env:deepseek': { ANTHROPIC_API_KEY: 'sk-old' },
    'env:gmi':     { ANTHROPIC_AUTH_TOKEN: 'gmi-old' },
  }, null, 2);
  writeFileSync(path, before);
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'mixed');
  assert.deepEqual(result.legacyKeys, ['env:deepseek', 'env:gmi']);
  assert.deepEqual(result.newKeys, ['deepseek', 'kimi']);
  assert.equal(readFileSync(path, 'utf8'), before, 'must not touch mixed files');
});

test('migrated: standard legacy shape → providers.<name>.apiKey, with backup', () => {
  const { path } = fixture();
  writeFileSync(path, JSON.stringify({
    'env:deepseek': { ANTHROPIC_API_KEY: 'sk-deepseek' },
    'env:kimi':    { ANTHROPIC_API_KEY: 'sk-kimi' },
    'env:gmi':     { ANTHROPIC_AUTH_TOKEN: 'gmi-token' },
  }));
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'migrated');
  assert.deepEqual(result.providers.sort(), ['deepseek', 'gmi', 'kimi']);
  assert.equal(result.backupPath, path + '.setup-bak');
  assert.ok(existsSync(result.backupPath), 'backup file must be created');

  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after, {
    providers: {
      deepseek: { apiKey: 'sk-deepseek' },
      kimi:    { apiKey: 'sk-kimi' },
      gmi:     { apiKey: 'gmi-token' },
    },
  });
  // Backup holds the pre-migration bytes
  const backup = JSON.parse(readFileSync(result.backupPath, 'utf8'));
  assert.deepEqual(backup, {
    'env:deepseek': { ANTHROPIC_API_KEY: 'sk-deepseek' },
    'env:kimi':    { ANTHROPIC_API_KEY: 'sk-kimi' },
    'env:gmi':     { ANTHROPIC_AUTH_TOKEN: 'gmi-token' },
  });
});

test('migrated: non-env:* top-level keys (e.g. fabric overrides) are preserved verbatim', () => {
  const { path } = fixture();
  writeFileSync(path, JSON.stringify({
    'env:deepseek': { ANTHROPIC_API_KEY: 'sk-x' },
    fabric: { token: 'local-fabric-override' },
  }));
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'migrated');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after, {
    providers: { deepseek: { apiKey: 'sk-x' } },
    fabric: { token: 'local-fabric-override' },
  });
});

test('migrated: env:* block with no string value is skipped (does not appear in result)', () => {
  const { path } = fixture();
  writeFileSync(path, JSON.stringify({
    'env:good': { ANTHROPIC_API_KEY: 'sk-good' },
    'env:empty': {},
    'env:nested': { sub: { ANTHROPIC_API_KEY: 'sk-deep' } }, // not a top-level string
  }));
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'migrated');
  assert.deepEqual(result.providers, ['good']);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.providers.good.apiKey, 'sk-good');
  assert.equal(after.providers.empty, undefined);
  assert.equal(after.providers.nested, undefined);
});

test('migrated: first string value wins when env:* block has multiple keys', () => {
  const { path } = fixture();
  writeFileSync(path, JSON.stringify({
    'env:multi': { FIRST_KEY: 'sk-first', SECOND_KEY: 'sk-second' },
  }));
  const result = migrateLocalEnvSettings({ localPath: path });
  assert.equal(result.status, 'migrated');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  // Object.values() returns values in insertion order; "sk-first" comes first
  assert.equal(after.providers.multi.apiKey, 'sk-first');
});

test('migrated: result is idempotent — re-running on a migrated file is a no-op', () => {
  const { path } = fixture();
  writeFileSync(path, JSON.stringify({
    'env:deepseek': { ANTHROPIC_API_KEY: 'sk-d' },
  }));
  const first = migrateLocalEnvSettings({ localPath: path });
  assert.equal(first.status, 'migrated');
  // Delete the backup so re-running creates a fresh one (idempotency check)
  const after1 = readFileSync(path, 'utf8');
  const second = migrateLocalEnvSettings({ localPath: path });
  assert.equal(second.status, 'current');
  assert.equal(readFileSync(path, 'utf8'), after1, 'file must not be re-touched');
});
