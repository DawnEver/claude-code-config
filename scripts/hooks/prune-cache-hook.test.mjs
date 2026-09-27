import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('background cache scan does not interpolate a removed singular CACHE_ROOT', () => {
  const source = readFileSync(fileURLToPath(new URL('./prune-cache-hook.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /JSON\.stringify\(CACHE_ROOT\)/);
  assert.match(source, /const LIVE_CACHE = \$\{JSON\.stringify\(LIVE_CACHE\)\}/);
});
