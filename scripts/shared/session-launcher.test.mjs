// Every launch path runs the agent through ai-lab's ONE session launcher, `<python> -m ai_lab.session <claude|codex> [args]`
// (PLAN-a-short-robust-toolchain P4): it mints or inherits LAB_SESSION; cc-config issues none.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SESSION_MODULE, sessionSpawn } from './session-launcher.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const python = join(tmpdir(), 'venv', 'python.exe');
const has = () => true;

test('the agent runs as `<recorded python> -m ai_lab.session <agent> ...`', () => {
  assert.deepEqual(sessionSpawn('claude', ['-c', 'x'], { python, probe: has }),
    { command: python, args: ['-m', SESSION_MODULE, 'claude', '-c', 'x'] });
  assert.equal(SESSION_MODULE, 'ai_lab.session');
  assert.deepEqual(sessionSpawn('codex', [], { python, probe: has }).args, ['-m', 'ai_lab.session', 'codex']);
});

test('planted: an ai-lab without ai_lab.session, or no recorded interpreter, still launches the agent, saying why', () => {
  const old = sessionSpawn('claude', ['-c', 'x'], { python, probe: () => false });
  assert.deepEqual([old.command, old.args, old.error], ['claude', ['-c', 'x'], undefined]);
  assert.match(old.notice, /cannot import ai_lab.session.*without a lab session.*upgrade ai-lab.*setup/s);
  const none = sessionSpawn('codex', [], { python: null, probe: has });
  assert.deepEqual([none.command, none.args], ['codex', []]);
  assert.match(none.notice, /no ai-lab interpreter recorded.*without a lab session.*setup/s);
});

test('the default probe treats an interpreter that does not exist as no ai-lab', () => {
  const run = sessionSpawn('claude', [], { python: join(tmpdir(), 'no-such-python.exe') });
  assert.equal(run.command, 'claude');
  assert.match(run.notice, /cannot import/);
});

test('an agent ai_lab.session does not run is refused by name', () => {
  assert.match(sessionSpawn('gemini', [], { python, probe: has }).error, /gemini/);
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
