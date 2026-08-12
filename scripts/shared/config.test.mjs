// Unit tests for scripts/shared/config.mjs — the two-layer (shared + machine-local) merge.
// Local file paths are injected into a temp dir; the real ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepMerge, readMergedEnvSettings } from './config.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-config-'));
  return {
    shared: join(dir, 'claude_env_settings.json'),
    local: join(dir, 'claude_env_settings.local.json'),
  };
}

test('readMergedEnvSettings overlays machine-local keys over the shared config', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    'env:deepseek': { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-v4-flash[1m]' },
    fabric: { token: 'shared-token' },
  }));
  writeFileSync(local, JSON.stringify({
    'env:deepseek': { ANTHROPIC_API_KEY: 'sk-machine-local' },
  }));
  const merged = readMergedEnvSettings({ sharedPath: shared, localPath: local });
  assert.equal(merged['env:deepseek'].ANTHROPIC_API_KEY, 'sk-machine-local');
  assert.equal(merged['env:deepseek'].ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic'); // shared non-secret preserved
  assert.equal(merged['env:deepseek'].ANTHROPIC_MODEL, 'deepseek-v4-flash[1m]');
  assert.equal(merged.fabric.token, 'shared-token'); // untouched blocks untouched
});

test('readMergedEnvSettings returns the shared config unchanged when no local file exists', () => {
  const { shared } = fixture();
  writeFileSync(shared, JSON.stringify({ 'env:deepseek': { ANTHROPIC_BASE_URL: 'x' } }));
  const merged = readMergedEnvSettings({ sharedPath: shared, localPath: join(fixture().shared, '..', 'nope.json') });
  assert.equal(merged['env:deepseek'].ANTHROPIC_BASE_URL, 'x');
});

test('readMergedEnvSettings adds providers defined only locally', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({}));
  writeFileSync(local, JSON.stringify({ 'env:private': { ANTHROPIC_API_KEY: 'sk-p', ANTHROPIC_BASE_URL: 'https://p.test' } }));
  const merged = readMergedEnvSettings({ sharedPath: shared, localPath: local });
  assert.equal(merged['env:private'].ANTHROPIC_API_KEY, 'sk-p');
});

test('readMergedEnvSettings returns null when the shared file is missing', () => {
  assert.equal(readMergedEnvSettings({ sharedPath: join(tmpdir(), 'does-not-exist.json') }), null);
});

test('deepMerge overrides scalars and arrays, recurses into plain objects', () => {
  const out = deepMerge(
    { a: { x: 1, y: 2 }, b: 'base', c: ['s'], d: { n: [1, 2] } },
    { a: { y: 9 }, b: 'local', c: ['l'], d: { n: [3] } },
  );
  assert.deepEqual(out, { a: { x: 1, y: 9 }, b: 'local', c: ['l'], d: { n: [3] } });
});
