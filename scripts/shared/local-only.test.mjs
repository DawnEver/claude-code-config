import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOnly, LOCAL_ONLY_ENV } from './local-only.mjs';

test('only the exact value 1 marks a local-only session', () => {
  assert.equal(isLocalOnly({ [LOCAL_ONLY_ENV]: '1' }), true);
  assert.equal(isLocalOnly({}), false);
  assert.equal(isLocalOnly({ [LOCAL_ONLY_ENV]: '0' }), false);
});
