import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readBridgeConfig, repoNameFromUrl, gitContext, bridgeSourceRevision } from './context.mjs';

test('bridgeSourceRevision follows source edits, ignores tests and config, and exposes only a digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-revision-'));
  try {
    for (const dir of ['bridge', 'shared']) fs.mkdirSync(path.join(root, 'scripts', dir), { recursive: true });
    const file = path.join(root, 'scripts', 'bridge', 'daemon.mjs');
    fs.writeFileSync(file, 'export const version = 1;');
    fs.writeFileSync(path.join(root, 'scripts', 'shared', 'config.mjs'), 'export const config = {};');
    const initial = bridgeSourceRevision(root);
    assert.match(initial, /^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(root, 'scripts', 'bridge', 'daemon.test.mjs'), 'test only');
    fs.writeFileSync(path.join(root, 'secret.json'), 'secret');
    assert.equal(bridgeSourceRevision(root), initial);
    fs.writeFileSync(file, 'export const version = 2;');
    assert.notEqual(bridgeSourceRevision(root), initial);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repoNameFromUrl handles https, ssh, and no .git', () => {
  assert.equal(repoNameFromUrl('https://github.com/DawnEver/claude-code-config.git'), 'claude-code-config');
  assert.equal(repoNameFromUrl('git@forge.example:team/proj-x.git'), 'proj-x');
  assert.equal(repoNameFromUrl('https://h/o/name/'), 'name');
  assert.equal(repoNameFromUrl(null), null);
});

test('readBridgeConfig merges shared projects with local secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcfg-'));
  const sharedPath = path.join(dir, 's.json');
  const localPath = path.join(dir, 'l.json');
  fs.writeFileSync(sharedPath, JSON.stringify({ bridge: { fallbackChatId: -1, projects: { a: { chatId: -100 }, b: { chatId: null } } } }));
  fs.writeFileSync(localPath, JSON.stringify({ bridge: { botToken: '1:abc', allowedUserIds: ['42', 'x'], approvalsFromTelegram: true } }));
  try {
    assert.deepEqual(readBridgeConfig({ sharedPath, localPath }), {
      botToken: '1:abc', allowedUserIds: [42], approvalsFromTelegram: true, fallbackChatId: -1, idleCloseMinutes: 30, deleteClosedAfterHours: 24, projects: { a: { chatId: -100 } },
    });
    fs.writeFileSync(localPath, JSON.stringify({ bridge: { botToken: '123456:your-bot-token' } }));
    const c = readBridgeConfig({ sharedPath, localPath });
    assert.equal(c.botToken, null, 'template placeholder is not a token');
    assert.equal(c.approvalsFromTelegram, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitContext uses hints first and reads this checkout otherwise', () => {
  assert.deepEqual(gitContext('/nowhere', { originUrl: 'https://x/o/proj.git', branch: 'feat/x' }), { project: 'proj', branch: 'feat/x' });
  const here = gitContext(path.resolve(import.meta.dirname, '..', '..'));
  assert.ok(here.project);
  assert.ok(here.branch);
});
