import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  parseSetupArgs,
  adoptSyncDir,
  linkSourceRoot,
  linkEntry,
  sameVolume,
  isHardLinked,
  CLAUDE_LINKS,
  CODEX_LINKS,
} from './setup.js';
import { SYNC_PAYLOAD_FILES, readSyncDirPointer } from '../shared/sync-dir.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `setup-${p}-`));
const fakeHome = () => {
  const h = tmp('home');
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  return h;
};

// ── argv parsing ─────────────────────────────────────────────────────────────

test('parseSetupArgs: reads the flags setup understands', () => {
  assert.deepEqual(parseSetupArgs(['--replace']), {
    replace: true, initSyncDir: false, syncDir: undefined, syncDirFlagPresent: false,
  });
  assert.deepEqual(parseSetupArgs(['--sync-dir', '/x', '--init-sync-dir']), {
    replace: false, initSyncDir: true, syncDir: '/x', syncDirFlagPresent: true,
  });
  assert.equal(parseSetupArgs(['-r']).replace, true);
});

test('parseSetupArgs: setup() takes options, so a caller cannot leak its own argv', () => {
  // migrate.js calls setup() after parsing its OWN command line. When setup sniffed
  // process.argv directly, `node migrate.js --sync-dir /x` triggered a destructive file
  // move from a tool that advertises link cleanup.
  assert.equal(parseSetupArgs([]).syncDirFlagPresent, false);
});

// ── link table resolution ────────────────────────────────────────────────────

test("linkSourceRoot: base:'sync' resolves under syncDir, everything else under the repo", () => {
  const repoRoot = '/repo';
  const syncDir = '/payload';
  assert.equal(linkSourceRoot({ src: 'skills', base: undefined }, { repoRoot, syncDir }), repoRoot);
  assert.equal(linkSourceRoot({ src: 'claude_settings.json', base: 'sync' }, { repoRoot, syncDir }), syncDir);
});

test('linkSourceRoot: with no sync dir configured every entry resolves in the repo', () => {
  // The zero-config guarantee for users with no cloud storage.
  const repoRoot = '/repo';
  for (const link of [...CLAUDE_LINKS, ...CODEX_LINKS]) {
    assert.equal(linkSourceRoot(link, { repoRoot }), repoRoot, `${link.dest} escaped the repo`);
  }
});

test('exactly the payload files are marked base:sync', () => {
  const marked = [...CLAUDE_LINKS, ...CODEX_LINKS].filter(l => l.base === 'sync').map(l => l.src);
  assert.deepEqual(marked.sort(), ['claude_env_settings.json', 'claude_settings.json']);
  // codex_config.toml is intentionally NOT a link — it is composed per host.
  assert.equal([...CODEX_LINKS].some(l => l.src === 'codex_config.toml'), false);
});

// ── adoptSyncDir: the destructive move ───────────────────────────────────────

test('adoptSyncDir: moves payload files out of the repo and writes the pointer', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const target = path.join(tmp('cloud'), 'payload');
  for (const f of SYNC_PAYLOAD_FILES) fs.writeFileSync(path.join(repoRoot, f), `body-of-${f}`);

  const r = adoptSyncDir(target, { repoRoot, home });

  assert.deepEqual(r.moved.sort(), [...SYNC_PAYLOAD_FILES].sort());
  for (const f of SYNC_PAYLOAD_FILES) {
    assert.equal(fs.readFileSync(path.join(target, f), 'utf8'), `body-of-${f}`);
    assert.ok(!fs.existsSync(path.join(repoRoot, f)), `${f} must be MOVED, not copied`);
  }
  assert.equal(readSyncDirPointer(home), path.resolve(target));
});

test('adoptSyncDir: never clobbers an existing sync copy — it is the shared one', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const target = tmp('cloud');
  fs.writeFileSync(path.join(repoRoot, 'claude_settings.json'), 'STALE repo copy');
  fs.writeFileSync(path.join(target, 'claude_settings.json'), 'REAL shared copy');

  const r = adoptSyncDir(target, { repoRoot, home });

  assert.equal(fs.readFileSync(path.join(target, 'claude_settings.json'), 'utf8'), 'REAL shared copy');
  assert.ok(r.skipped.includes('claude_settings.json'));
  assert.ok(fs.existsSync(path.join(repoRoot, 'claude_settings.json')), 'stale copy is reported, not silently deleted');
});

test('adoptSyncDir: writes the pointer only AFTER the files are in place', () => {
  // If the pointer were written first and a move then threw, the next plain setup run
  // would see a half-populated dir and template-seed the rest into cloud storage.
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const target = path.join(tmp('cloud'), 'payload');
  fs.writeFileSync(path.join(repoRoot, 'claude_settings.json'), 'x');

  assert.equal(readSyncDirPointer(home), null);
  adoptSyncDir(target, { repoRoot, home });
  assert.equal(readSyncDirPointer(home), path.resolve(target));
  assert.ok(fs.existsSync(path.join(target, 'claude_settings.json')));
});

test('adoptSyncDir: is a no-op move when the target IS the repo', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  fs.writeFileSync(path.join(repoRoot, 'claude_settings.json'), 'x');

  const r = adoptSyncDir(repoRoot, { repoRoot, home });
  assert.deepEqual(r.moved, []);
  assert.ok(fs.existsSync(path.join(repoRoot, 'claude_settings.json')));
});

test('adoptSyncDir: is idempotent', () => {
  const home = fakeHome();
  const repoRoot = tmp('repo');
  const target = path.join(tmp('cloud'), 'payload');
  fs.writeFileSync(path.join(repoRoot, 'claude_settings.json'), 'x');

  adoptSyncDir(target, { repoRoot, home });
  const second = adoptSyncDir(target, { repoRoot, home });

  assert.deepEqual(second.moved, [], 'nothing left to move');
  assert.equal(fs.readFileSync(path.join(target, 'claude_settings.json'), 'utf8'), 'x');
});

// ── hard links vs cross-volume copies ────────────────────────────────────────

// A working tree on D: with ~/.claude on C: cannot be hard linked. Find a writable
// root on a different volume so that case can be exercised for real; returns null
// on a single-volume host (macOS), where these tests are skipped.
function secondVolumeTmp() {
  if (process.platform !== 'win32') return null;
  const baseDev = fs.statSync(os.tmpdir()).dev;
  for (const letter of ['D', 'E', 'F', 'C']) {
    const root = `${letter}:/`;
    try {
      if (!fs.existsSync(root)) continue;
      const dir = fs.mkdtempSync(path.join(root, 'setup-xvol-'));
      if (fs.statSync(dir).dev !== baseDev) return dir;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Root not writable — try the next one.
    }
  }
  return null;
}

const XVOL = secondVolumeTmp();
const xvolSkip = XVOL ? false : 'needs a second writable volume';
// XVOL sits at a volume root rather than under os.tmpdir(), so nothing else will sweep it.
if (XVOL) after(() => fs.rmSync(XVOL, { recursive: true, force: true }));
const HARDLINK = { src: 'config.json', dest: 'config.json', type: 'file', hardlink: true };

test('sameVolume: true within one volume, false across two', { skip: xvolSkip }, () => {
  const a = tmp('vol');
  assert.equal(sameVolume(a, a), true);
  assert.equal(sameVolume(a, XVOL), false);
});

test('linkEntry: a hardlink entry on one volume really is hard linked', () => {
  const src = path.join(tmp('src'), 'config.json');
  const dest = path.join(tmp('dest'), 'config.json');
  fs.writeFileSync(src, '{"a":1}');

  const r = linkEntry(src, dest, HARDLINK, false);
  assert.equal(r.kind, 'hardlink');
  assert.ok(isHardLinked(src, dest));
});

test('linkEntry: across volumes a hardlink entry falls back to a copy, not an error', { skip: xvolSkip }, () => {
  const src = path.join(tmp('src'), 'config.json');
  const dest = path.join(fs.mkdtempSync(path.join(XVOL, 'dest-')), 'config.json');
  fs.writeFileSync(src, '{"a":1}');

  const r = linkEntry(src, dest, HARDLINK, false);
  assert.equal(r.kind, 'copy');
  // The consumer rejects symlinks, so the fallback must be a genuine regular file.
  assert.ok(fs.lstatSync(dest).isFile() && !fs.lstatSync(dest).isSymbolicLink());
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"a":1}');
});

test('linkEntry: an up-to-date cross-volume copy is satisfied, not re-reported', { skip: xvolSkip }, () => {
  const src = path.join(tmp('src'), 'config.json');
  const dest = path.join(fs.mkdtempSync(path.join(XVOL, 'dest-')), 'config.json');
  fs.writeFileSync(src, '{"a":1}');
  linkEntry(src, dest, HARDLINK, false);

  const second = linkEntry(src, dest, HARDLINK, false);
  assert.equal(second.status, 'ok', 'a matching copy is the satisfied state');
  assert.match(second.message, /copy/);
});

test('linkEntry: a drifted cross-volume copy is never overwritten without --replace', { skip: xvolSkip }, () => {
  const src = path.join(tmp('src'), 'config.json');
  const dest = path.join(fs.mkdtempSync(path.join(XVOL, 'dest-')), 'config.json');
  fs.writeFileSync(src, '{"a":1}');
  fs.writeFileSync(dest, '{"edited-live":true}');

  const r = linkEntry(src, dest, HARDLINK, false);
  assert.equal(r.status, 'skip');
  assert.match(r.message, /drifted/);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"edited-live":true}', 'live edits survive');
});

test('linkEntry: --replace re-syncs a drifted copy and keeps the old one', { skip: xvolSkip }, () => {
  const src = path.join(tmp('src'), 'config.json');
  const dest = path.join(fs.mkdtempSync(path.join(XVOL, 'dest-')), 'config.json');
  fs.writeFileSync(src, '{"a":1}');
  fs.writeFileSync(dest, '{"edited-live":true}');

  const r = linkEntry(src, dest, HARDLINK, true);
  assert.equal(r.kind, 'copy');
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(`${dest}.setup-bak`, 'utf8'), '{"edited-live":true}');
});
