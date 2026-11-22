import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveCodexHome, codexHomeKey } from './codex-home.mjs';

test('one resolver honors explicit homes without guessing account directories', () => {
  const home = path.resolve('fixture-home');
  assert.equal(resolveCodexHome({ env: {}, home }), path.join(home, '.codex'));
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: '~/codex-work' }, home }), path.join(home, 'codex-work'));
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: 'relative' }, home, cwd: home }), path.join(home, 'relative'));
  assert.equal(codexHomeKey(home), codexHomeKey(home));
  assert.notEqual(codexHomeKey(home), codexHomeKey(path.join(home, 'other')));
  assert.doesNotMatch(codexHomeKey(home), /fixture-home/);
});

test('codexHomes: the base home, then every other home a launch recorded and still present; each with its label', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { recordCodexHome, codexHomes, codexHomeLabel } = await import('./codex-home.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-'));
  const file = path.join(home, '.claude', 'bridge', 'codex-homes.json');
  const work = path.join(home, '.codex-work'), other = path.join(home, 'accounts', 'Codex Two');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  assert.deepEqual(codexHomes({ file, home }), [path.join(home, '.codex')], 'no record: the base home alone');
  recordCodexHome(path.join(home, '.codex'), { file, home });
  assert.equal(fs.existsSync(file), false, 'the base home is never recorded');
  recordCodexHome(work, { file, home });
  recordCodexHome(work, { file, home });
  recordCodexHome(other, { file, home });
  assert.deepEqual(codexHomes({ file, home }), [path.join(home, '.codex'), work, other]);
  fs.rmSync(other, { recursive: true });
  assert.deepEqual(codexHomes({ file, home }), [path.join(home, '.codex'), work], 'a removed home drops out');
  assert.equal(codexHomeLabel(path.join(home, '.codex'), home), null);
  assert.equal(codexHomeLabel(work, home), 'work');
  assert.equal(codexHomeLabel(other, home), 'codex-two');
  fs.rmSync(home, { recursive: true, force: true });
});
