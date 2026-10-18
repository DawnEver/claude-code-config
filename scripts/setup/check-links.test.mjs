import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { healSyncLinks } from './check-links.js';
import { isHardLinked, sameVolume } from './setup.js';

// 2026-10-18: OneDrive replaced the synced settings on download, which broke this host's hard
// link; the host read a private copy for 11 days and every edit stayed on one side.
const LINK = { src: 'claude_env_settings.json', dest: 'claude_env_settings.json', type: 'file', base: 'sync' };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-'));
  const syncDir = path.join(root, 'sync'), dir = path.join(root, 'claude');
  fs.mkdirSync(syncDir); fs.mkdirSync(dir);
  const src = path.join(syncDir, LINK.src), dest = path.join(dir, LINK.dest);
  fs.writeFileSync(src, '{"v":1}');
  fs.linkSync(src, dest);
  // What a cloud client does on download: a new file renamed over the synced one.
  const cloudReplace = (text) => { fs.writeFileSync(`${src}.tmp`, text); fs.renameSync(`${src}.tmp`, src); };
  const heal = () => healSyncLinks({ syncDir, tables: [{ links: [LINK], dir }] });
  return { root, src, dest, cloudReplace, heal };
}
const age = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };

test('a link the cloud broke is re-linked to the sync copy: nothing was edited here since', () => {
  const f = fixture();
  try {
    f.cloudReplace('{"v":2}');
    age(f.dest, 60000);
    assert.equal(isHardLinked(f.src, f.dest), false, 'the replace detached it');
    assert.deepEqual(f.heal(), { repaired: [f.dest], conflicts: [] });
    assert.equal(isHardLinked(f.src, f.dest), true);
    assert.equal(fs.readFileSync(f.dest, 'utf8'), '{"v":2}', 'reads what the other hosts wrote');
    assert.equal(fs.readFileSync(`${f.dest}.setup-bak`, 'utf8'), '{"v":1}', 'the private copy is kept');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a detached copy edited here since is a conflict: reported, never overwritten', () => {
  const f = fixture();
  try {
    f.cloudReplace('{"v":2}');
    age(f.src, 60000);
    fs.writeFileSync(f.dest, '{"v":"local edit"}');
    assert.deepEqual(f.heal(), { repaired: [], conflicts: [f.dest] });
    assert.equal(fs.readFileSync(f.dest, 'utf8'), '{"v":"local edit"}');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('an intact link is left alone', () => {
  const f = fixture();
  try { assert.deepEqual(f.heal(), { repaired: [], conflicts: [] }); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('sameVolume on Windows is the drive, whatever dev a cloud-managed file reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));
  try {
    fs.writeFileSync(path.join(root, 'a'), 'x');
    assert.equal(sameVolume(path.join(root, 'a'), root, 'win32'), true);
    assert.equal(sameVolume(path.join(root, 'missing'), root, 'win32'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
