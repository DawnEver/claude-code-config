import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readBridgeConfig, bridgeAllowlist, repoNameFromUrl, gitContext, bridgeSourceRevision, bridgeConfigRevision } from './context.mjs';

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
      botToken: '1:abc', approvalsFromTelegram: true, fallbackChatId: -1, idleCloseMinutes: 30, deleteClosedAfterHours: 24, codexSources: ['cli', 'vscode'], dashboard: null, dashboardError: null, hpc: null, hpcError: null, balances: [], forges: [], projects: { a: { chatId: -100, projectInTitle: 'always' } },
    });
    fs.writeFileSync(sharedPath, JSON.stringify({ bridge: { codexSources: ['cli', 'vscode', 7] } }));
    assert.deepEqual(readBridgeConfig({ sharedPath, localPath }).codexSources, ['cli', 'vscode']);
    fs.writeFileSync(localPath, JSON.stringify({ bridge: { botToken: '123456:your-bot-token' } }));
    const c = readBridgeConfig({ sharedPath, localPath });
    assert.equal(c.botToken, null, 'template placeholder is not a token');
    assert.equal(c.approvalsFromTelegram, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridgeAllowlist: the declared user, never the local allowedUserIds key, which is named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballow-'));
  const sharedPath = path.join(dir, 's.json');
  const localPath = path.join(dir, 'l.json');
  fs.writeFileSync(sharedPath, JSON.stringify({ bridge: {} }));
  fs.writeFileSync(localPath, JSON.stringify({ bridge: { allowedUserIds: [666] } }));
  const declaration = { channels: { 'session-bridge': '42' }, why: null };
  try {
    const got = bridgeAllowlist({ sharedPath, localPath, declaration });
    assert.deepEqual(got.allowedUserIds, [42]);
    assert.match(got.stale, /bridge\.allowedUserIds is no longer read/);
    assert.equal('allowedUserIds' in readBridgeConfig({ sharedPath, localPath }), false, 'the settings key is not read');
    const closed = bridgeAllowlist({ sharedPath, localPath, declaration: { channels: {}, why: 'door failed: exit 1' } });
    assert.deepEqual(closed.allowedUserIds, [], 'unreadable declaration: nobody, never the local key');
    assert.match(closed.why, /door failed.*hosts-config/);
    fs.writeFileSync(localPath, JSON.stringify({ bridge: {} }));
    assert.equal(bridgeAllowlist({ sharedPath, localPath, declaration }).stale, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readBridgeConfig: a leftover bridge.alerts is ignored (Telegram quota alerts are gone)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  try {
    const sharedPath = path.join(dir, 's.json'), localPath = path.join(dir, 'l.json');
    fs.writeFileSync(localPath, '{}');
    fs.writeFileSync(sharedPath, JSON.stringify({ bridge: { alerts: { chatId: -1 } } }));
    assert.equal('alerts' in readBridgeConfig({ sharedPath, localPath }), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gitContext uses hints first and reads this checkout otherwise', () => {
  assert.deepEqual(gitContext('/nowhere', { originUrl: 'https://x/o/proj.git', branch: 'feat/x' }), { repo: 'x/o/proj', project: 'proj', branch: 'feat/x' });
  const here = gitContext(path.resolve(import.meta.dirname, '..', '..'));
  assert.ok(here.project);
  assert.ok(here.branch);
});

// The daemon resolves the channel allowlist once at start, and both its change check and
// ensure.mjs compare this fingerprint: a declaration the fingerprint did not carry never
// restarted it (2026-11-23: a newly declared channel stayed "allowlist empty" until the daemon was
// killed by hand).
test('the config fingerprint carries the declared allowlist, so a new declaration restarts the daemon', () => {
  const config = { botToken: 't', projects: {} };
  assert.notEqual(bridgeConfigRevision(config, []), bridgeConfigRevision(config, [8068396521]), 'a newly declared user changes it');
  assert.equal(bridgeConfigRevision(config, [8068396521]), bridgeConfigRevision(config, [8068396521]), 'PLANTED CONTROL: an unchanged declaration does not');
  const src = fs.readFileSync(new URL('./context.mjs', import.meta.url), 'utf8');
  assert.match(src, /export function bridgeConfigRevision\(config = readBridgeConfig\(\), allowedUserIds = bridgeAllowlist\(\)\.allowedUserIds\)/,
    'with no arguments (the daemon and ensure.mjs) it reads the declaration itself');
});
