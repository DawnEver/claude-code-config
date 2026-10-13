import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyGlobalDefaults, GLOBAL_DEFAULTS } from './claude-defaults.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-defaults-')), '.claude.json');

test('applyGlobalDefaults closes the diff panel and keeps every other key', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' }, diffSidebarOpen: true }));
  assert.equal(applyGlobalDefaults(file), true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.diffSidebarOpen, false);
  assert.deepEqual(after.oauthAccount, { emailAddress: 'a@example.com' });
  assert.deepEqual(GLOBAL_DEFAULTS, { diffSidebarOpen: false });
});

test('applyGlobalDefaults leaves a current file untouched', () => {
  const file = tmp();
  fs.writeFileSync(file, '{"diffSidebarOpen":false}');
  const before = fs.statSync(file).mtimeMs;
  assert.equal(applyGlobalDefaults(file), false);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('applyGlobalDefaults never creates or clobbers a missing or unreadable file', () => {
  const missing = tmp();
  assert.equal(applyGlobalDefaults(missing), false);
  assert.equal(fs.existsSync(missing), false);
  const broken = tmp();
  fs.writeFileSync(broken, '{not json');
  assert.equal(applyGlobalDefaults(broken), false);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{not json');
});
