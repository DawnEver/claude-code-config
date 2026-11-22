import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshProviderCache } from './provider-setup.mjs';
import { documentFor, fakeAiLab, writeCache } from '../shared/provider-cache-fixture.mjs';
import { ownPython } from '../shared/own-python.mjs';

// ── temp homes and a fake ai-lab only; the real store is never touched ──

const runner = (doc, seen) => (cmd) => { seen.push(cmd); return { status: 0, stdout: JSON.stringify(doc), stderr: '' }; };

// 2026-11-22: the refresh ran under the interpreter a previous cache recorded (ai-lab's own venv, borrowed);
// it runs under cc-config's own environment, whose lock pins ai-lab.
test('refresh runs ai_lab.providers under cc-config\'s own interpreter, never a recorded one', () => {
  const lab = fakeAiLab();
  const path = writeCache(lab);
  const seen = [];
  assert.equal(refreshProviderCache({ path, run: runner(documentFor(lab), seen) }).ok, true);
  assert.deepEqual(seen, [ownPython()]);
});
