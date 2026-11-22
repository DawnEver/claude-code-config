import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnEnv } from './own-env.mjs';
import { OWN_ROOT } from '../shared/own-python.mjs';

test('setup builds this checkout\'s own environment from its lock, frozen', () => {
  let called;
  const res = buildOwnEnv({ run: (cmd, args) => { called = [cmd, ...args]; return { status: 0 }; } });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(called, ['uv', 'sync', '--frozen', '--project', OWN_ROOT]);
});

test('a missing uv or a failed sync refuses by name', () => {
  assert.match(buildOwnEnv({ run: () => ({ error: Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }) }) }).error, /uv is not installed/);
  assert.match(buildOwnEnv({ run: () => ({ status: 2, stderr: 'error: lock out of date\n' }) }).error, /uv sync .* failed: error: lock out of date/);
});
