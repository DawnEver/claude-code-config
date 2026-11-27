import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOnly, LOCAL_ONLY_ENV } from './local-only.mjs';

test('only the exact value 1 marks a local-only session', () => {
  assert.equal(isLocalOnly({ [LOCAL_ONLY_ENV]: '1' }), true);
  assert.equal(isLocalOnly({}), false);
  assert.equal(isLocalOnly({ [LOCAL_ONLY_ENV]: '0' }), false);
});

test('a provider is local when its catalogue row is auth "local"; a broken cache makes none local', async () => {
  const { isLocalProvider } = await import('./local-only.mjs');
  const read = () => ({ cache: { providers: { llamacpp: { auth: 'local' }, deepseek: { auth: 'api' } } } });
  assert.equal(isLocalProvider('llamacpp', read), true);
  assert.equal(isLocalProvider('deepseek', read), false);
  assert.equal(isLocalProvider(undefined, read), false);
  assert.equal(isLocalProvider('llamacpp', () => ({ error: 'stale' })), false);
});
