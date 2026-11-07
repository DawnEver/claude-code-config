// Every launch path runs the agent through ai-lab's ONE session launcher, `<python> -m ai_lab.session <claude|codex> [args]`
// (PLAN-a-short-robust-toolchain P4): it mints or inherits LAB_SESSION; cc-config issues none.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { venvFingerprint, ensureImportable, SESSION_MODULE, sessionSpawn } from './session-launcher.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const python = join(tmpdir(), 'venv', 'python.exe');
const has = () => ({ ok: true });

test('the agent runs as `<recorded python> -m ai_lab.session <agent> ...`', () => {
  assert.deepEqual(sessionSpawn('claude', ['-c', 'x'], { python, ensure: has }),
    { command: python, args: ['-m', SESSION_MODULE, 'claude', '-c', 'x'] });
  assert.equal(SESSION_MODULE, 'ai_lab.session');
  assert.deepEqual(sessionSpawn('codex', [], { python, ensure: has }).args, ['-m', 'ai_lab.session', 'codex']);
});

test('planted: an ai-lab without ai_lab.session, or no recorded interpreter, still launches the agent, saying why', () => {
  const old = sessionSpawn('claude', ['-c', 'x'], { python, ensure: () => ({ ok: false, why: 'ModuleNotFoundError: x' }) });
  assert.deepEqual([old.command, old.args, old.error], ['claude', ['-c', 'x'], undefined]);
  assert.match(old.notice, /cannot import ai_lab\.session \(ModuleNotFoundError: x\).*without a lab session.*setup/s);
  const none = sessionSpawn('codex', [], { python: null, ensure: has });
  assert.deepEqual([none.command, none.args], ['codex', []]);
  assert.match(none.notice, /no ai-lab interpreter recorded.*without a lab session.*setup/s);
});

test('the default probe treats an interpreter that does not exist as no ai-lab', () => {
  const run = sessionSpawn('claude', [], { python: join(tmpdir(), 'no-such-python.exe') });
  assert.equal(run.command, 'claude');
  assert.match(run.notice, /cannot import/);
});

test('an agent ai_lab.session does not run is refused by name', () => {
  assert.match(sessionSpawn('gemini', [], { python, ensure: has }).error, /gemini/);
});

test('cc.js and codex.js spawn through sessionSpawn; no file spawns claude or codex directly', () => {
  for (const [file, agent] of [['cc.js', 'claude'], ['codex.js', 'codex']]) {
    const text = readFileSync(join(here, '..', 'runtime', file), 'utf8');
    assert.ok(text.includes(`sessionSpawn('${agent}'`), file);
  }
  let direct = '';
  try {
    direct = execFileSync('git', ['grep', '-l', '-E', String.raw`(prepareSpawn|spawn\w*|execFile\w*)\(\s*['"](claude|codex)['"]`, '--', 'scripts/runtime'],
      { cwd: join(here, '..', '..'), encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;  // 1: no match
  }
  assert.equal(direct, '', 'a direct spawn would bypass the session launcher');
});

// The 2026-11-07 incident: the tree moved to code needing a newer lab_commons while the venv still held the old
// one, and the launch died in a traceback. Whoever moved the tree, the launch syncs the venv before trusting it.
test('a venv behind its tree is synced to the lock before the launch, then probed again', () => {
  const probes = [{ ok: false, why: "ModuleNotFoundError: No module named 'lab_commons.config'" }, { ok: true }];
  const synced = [], logs = [];
  const ready = ensureImportable(python, { verified: null,
    probe: () => probes.shift(), project: () => 'proj', sync: (dir) => { synced.push(dir); return true; }, log: (m) => logs.push(m),
  });
  assert.deepEqual([ready, synced], [{ ok: true }, ['proj']]);
  assert.match(logs[0], /lab_commons.config.*syncing its venv/);
});

test('an importable venv is not synced; a non-uv interpreter or a failed sync reports why', () => {
  const never = () => { throw new Error('must not sync'); };
  assert.deepEqual(ensureImportable(python, { verified: null, probe: () => ({ ok: true }), sync: never }), { ok: true });
  const bad = { ok: false, why: 'boom' };
  assert.deepEqual(ensureImportable(python, { verified: null, probe: () => bad, project: () => null, sync: never }), bad);
  assert.match(ensureImportable(python, { verified: null, probe: () => bad, project: () => 'proj', sync: () => false }).why, /boom; uv sync in proj failed/);
});

test('a launch whose lock and HEAD are unchanged since a verified one skips the import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-lab-fp-'));
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40));
  writeFileSync(join(dir, 'uv.lock'), 'v1');
  const verified = join(dir, 'verified');
  let probes = 0;
  const opts = { verified, project: () => dir, probe: () => { probes += 1; return { ok: true }; }, sync: () => false };
  ensureImportable(python, opts); ensureImportable(python, opts);
  assert.equal(probes, 1, 'the second launch trusts the fingerprint');
  writeFileSync(join(dir, 'uv.lock'), 'v2 longer');
  ensureImportable(python, opts);
  assert.equal(probes, 2, 'a changed lock is probed again');
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'b'.repeat(40) + '\n');
  ensureImportable(python, opts);
  assert.equal(probes, 3, 'a moved branch is probed again');
  const fail = { ...opts, probe: () => ({ ok: false, why: 'x' }) };
  writeFileSync(join(dir, 'uv.lock'), 'v3 longer still');
  assert.equal(ensureImportable(python, fail).ok, false);
  assert.notEqual(readFileSync(verified, 'utf8'), venvFingerprint(python, dir), 'a failure is never recorded as verified');
});
