// Planted refusal: a launcher wrapper on a host without Node names what is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdWrapper, shWrapper } from './install-cli-wrappers.js';

const sh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['sh'], { encoding: 'utf8' })
  .stdout?.split(/\r?\n/)[0]?.trim();

test('planted refusal: no Node -> the sh wrapper refuses by name with 127', { skip: !sh && 'no sh on this host' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
  const file = join(dir, 'ccds');
  writeFileSync(file, shWrapper('ccds', '/nowhere/cc.js', 'deepseek "$@"'));
  const empty = mkdtempSync(join(tmpdir(), 'empty-path-'));
  const res = spawnSync(sh, [file], { encoding: 'utf8', env: { PATH: empty } });
  assert.equal(res.status, 127);
  assert.match(res.stderr, /ccds needs Node: install Node\.js/);
});

test('the cmd wrapper carries the same refusal before calling node', () => {
  const text = cmdWrapper('ccds', 'C:/x/cc.js', 'deepseek %*');
  assert.match(text, /where.exe" node >nul 2>nul \|\| \(echo ccds needs Node: .* & exit \/b 127\)\nnode "C:\/x\/cc\.js" deepseek %\*/);
});
