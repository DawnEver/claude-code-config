import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAgyConfig } from './doctor.js';
import { installAgyConfig } from './agy-config.mjs';

test('checkAgyConfig: silent without agy, FAIL on a missing managed part, WARN until a hook ran', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agyHome = path.join(home, '.gemini', 'config');
  const scriptsDir = path.join(home, '.claude', 'scripts');
  const repoRoot = path.join(home, 'repo');
  assert.deepEqual(checkAgyConfig({ agyHome, scriptsDir, repoRoot }), []);
  fs.mkdirSync(agyHome, { recursive: true });
  const ids = checkAgyConfig({ agyHome, scriptsDir, repoRoot }).map(f => f.id);
  assert.ok(ids.includes('agy-native-hooks') && ids.includes('agy-mcp'));
  installAgyConfig({ agyDir: agyHome, scriptsDir, repoRoot, smoke: () => ({ ok: true }) });
  assert.deepEqual(checkAgyConfig({ agyHome, scriptsDir, repoRoot }).map(f => f.level), ['WARN']);
});
