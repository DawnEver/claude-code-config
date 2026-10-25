// Every launch path runs the agent through ai-lab's ONE session launcher, `ai-lab-session <claude|codex> [args]`
// (PLAN-a-short-robust-toolchain P4): it mints or inherits LAB_SESSION; cc-config issues none.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SESSION_LAUNCHER, sessionSpawn } from './session-launcher.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const exe = (platform) => (platform === 'win32' ? `${SESSION_LAUNCHER}.exe` : SESSION_LAUNCHER);

function venv({ withLauncher = true, platform = process.platform } = {}) {
  const bin = join(mkdtempSync(join(tmpdir(), 'session-launcher-')), platform === 'win32' ? 'Scripts' : 'bin');
  mkdirSync(bin, { recursive: true });
  const python = join(bin, platform === 'win32' ? 'python.exe' : 'python');
  writeFileSync(python, '');
  if (withLauncher) writeFileSync(join(bin, exe(platform)), '');
  return { bin, python };
}

test('the agent runs through ai-lab-session beside the provider cache\'s ai-lab interpreter', () => {
  for (const platform of ['win32', 'linux']) {
    const { bin, python } = venv({ platform });
    assert.deepEqual(sessionSpawn('claude', ['-c', 'x'], { python, platform }), { command: join(bin, exe(platform)), args: ['claude', '-c', 'x'] });
    assert.deepEqual(sessionSpawn('codex', [], { python, platform }).args, ['codex']);
  }
});

test('planted: an ai-lab without ai-lab-session, or no recorded interpreter, refuses naming setup', () => {
  const { python } = venv({ withLauncher: false });
  assert.match(sessionSpawn('claude', [], { python }).error, /ai-lab-session.*not installed beside.*setup/s);
  assert.match(sessionSpawn('claude', [], { python: null }).error, /no ai-lab interpreter recorded.*setup/s);
});

test('an agent ai-lab-session does not run is refused by name', () => {
  const { python } = venv();
  assert.match(sessionSpawn('gemini', [], { python }).error, /gemini/);
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
