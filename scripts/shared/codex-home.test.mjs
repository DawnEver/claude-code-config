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
