import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { refreshProviderCache } from './provider-setup.mjs';
import { documentFor, fakeAiLab, writeCache } from '../shared/provider-cache-fixture.mjs';

// ── key migration: temp homes and a fake ai-lab only; the real store is never touched ──

const runner = (doc, seen) => (cmd) => { seen.push(cmd); return { status: 0, stdout: JSON.stringify(doc), stderr: '' }; };

test('refresh without --ai-lab-python reuses the interpreter the previous cache recorded', () => {
  const lab = fakeAiLab();
  const path = writeCache(lab);
  const seen = [];
  assert.equal(refreshProviderCache({ path, run: runner(documentFor(lab), seen) }).ok, true);
  assert.deepEqual(seen, [lab.python]);
});

test('--ai-lab-python wins over the recorded interpreter', () => {
  const lab = fakeAiLab();
  const path = writeCache(lab);
  const seen = [];
  refreshProviderCache({ aiLabPython: '/other/python', path, run: runner(documentFor(lab), seen) });
  assert.deepEqual(seen, ['/other/python']);
});

test('first setup with no flag and no cache refuses, naming the flag', () => {
  const lab = fakeAiLab();
  const res = refreshProviderCache({ path: join(lab.dir, 'none.json'), run: () => assert.fail('must not run') });
  assert.match(res.error, /--ai-lab-python/);
});
