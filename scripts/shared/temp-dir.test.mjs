// Temp is reclaimed: tempDir() removes what it made at exit, no test makes a temp directory any other way, and
// run-tests.mjs refuses a run that leaves anything in its temp root. Each guard has its planted negative beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { runSuite } from './run-tests.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const helperUrl = new URL('./temp-dir.mjs', import.meta.url).href;

// The two files that legitimately call mkdtemp/tmpdir(): the helper, and the runner that owns the suite's root.
const OWNERS = new Set(['scripts/shared/temp-dir.mjs', 'scripts/shared/run-tests.mjs', 'scripts/shared/temp-dir.test.mjs']);
const MAKES_TEMP = /\bmkdtemp(Sync)?\s*\(|\btmpdir\s*\(\s*\)/;

/** Test code: every *.test.mjs / *.spec.mjs and every *fixture*.mjs the tests import. */
function testFiles() {
  const out = execFileSync('git', ['ls-files', '*.test.mjs', '*.spec.mjs', '*fixture*.mjs'], { cwd: repo, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter((f) => !f.startsWith('.claude/'));
}

export function offenders(files, read) {
  return files.filter((f) => !OWNERS.has(f) && MAKES_TEMP.test(read(f)));
}

test('tempDir hands out a fresh directory and removes it when the process exits', () => {
  const script = `import { tempDir } from ${JSON.stringify(helperUrl)};\nconsole.log(tempDir('probe-'));`;
  const dir = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  assert.match(dir, /probe-/);
  assert.equal(existsSync(dir), false, `${dir} survived the process that made it`);
});

test('no test makes a temp directory outside temp-dir.mjs', () => {
  const bad = offenders(testFiles(), (f) => readFileSync(join(repo, f), 'utf8'));
  assert.deepEqual(bad, [], `route these through tempDir() from scripts/shared/temp-dir.mjs: ${bad.join(', ')}`);
});

test('planted control: the scan flags a test that calls mkdtempSync or tmpdir() itself', () => {
  const planted = { 'a.test.mjs': "mkdtempSync(join(tmpdir(), 'x-'))", 'b.test.mjs': 'const d = os.tmpdir();', 'c.test.mjs': "tempDir('x-')" };
  assert.deepEqual(offenders(Object.keys(planted), (f) => planted[f]), ['a.test.mjs', 'b.test.mjs']);
});

test('run-tests refuses a run that leaves an entry in the temp root, and passes a clean one', () => {
  const dir = tempDir('run-tests-');
  const leaky = join(dir, 'leaky.test.mjs');
  const clean = join(dir, 'clean.test.mjs');
  writeFileSync(leaky, "import { test } from 'node:test'; import { mkdtempSync } from 'node:fs'; import { join } from 'node:path'; import os from 'node:os';\ntest('leaks', () => { mkdtempSync(join(os.tmpdir(), 'leak-')); });\n");
  writeFileSync(clean, `import { test } from 'node:test'; import { tempDir } from ${JSON.stringify(helperUrl)};\ntest('reclaims', () => { tempDir('kept-'); });\n`);
  const bad = runSuite([leaky], { stdio: 'pipe', cwd: dir });
  assert.equal(bad.status, 0);
  assert.equal(bad.left.length, 1);
  assert.match(bad.left[0], /^leak-/);
  const good = runSuite([clean], { stdio: 'pipe', cwd: dir });
  assert.equal(good.status, 0);
  assert.deepEqual(good.left, []);
});
