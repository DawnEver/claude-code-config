import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { wrapperPaths, removeLegacyProfileSources } from './install-cli-wrappers.js';

test('Windows wrapper paths include cmd and extensionless Git Bash entry points', () => {
  assert.deepEqual(wrapperPaths('C:\\host-bin', 'codc', true), [
    path.join('C:\\host-bin', 'codc.cmd'), path.join('C:\\host-bin', 'codc'),
  ]);
});

test('macOS and Linux use one extensionless executable wrapper', () => {
  assert.deepEqual(wrapperPaths('/usr/local/bin', 'codc', false), [path.join('/usr/local/bin', 'codc')]);
});

test('legacy profile source removal preserves unrelated content on Windows and POSIX', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-profile-'));
  const win = path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  const zsh = path.join(home, '.zshrc');
  fs.mkdirSync(path.dirname(win), { recursive: true });
  fs.writeFileSync(win, 'keep\r\n. ~/.claude/scripts/runtime/aliases.ps1\r\n');
  fs.writeFileSync(zsh, 'keep\n. ~/.claude/scripts/runtime/aliases.sh\n');
  removeLegacyProfileSources(home, 'win32');
  removeLegacyProfileSources(home, 'darwin');
  assert.doesNotMatch(fs.readFileSync(win, 'utf8'), /aliases\.ps1/);
  assert.doesNotMatch(fs.readFileSync(zsh, 'utf8'), /aliases\.sh/);
  assert.match(fs.readFileSync(win, 'utf8'), /keep/);
  assert.match(fs.readFileSync(zsh, 'utf8'), /keep/);
});
