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

test('localModelTest: every role model of a local row, none of an api row', async () => {
  const { localModelTest } = await import('./local-only.mjs');
  const is = localModelTest(() => ({ cache: { providers: { llamacpp: { auth: 'local', models: { base: 'qwen3.8-27b' } }, deepseek: { auth: 'api', models: { base: 'd' } } } } }));
  assert.equal(is('qwen3.8-27b'), true);
  assert.equal(is('d'), false);
  assert.equal(localModelTest(() => ({ error: 'stale' }))('qwen3.8-27b'), false);
});
