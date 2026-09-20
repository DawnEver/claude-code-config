import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { posixProfilePaths, installPosixProfileAliasSource } from './install-shell-aliases.js';

// The wrappers setup writes only work when the target bin dir is on PATH. Sourcing
// aliases.sh is the PATH-independent route — its own header has claimed "sourced by
// ~/.bashrc / ~/.zshrc" since it was written, but nothing ever wrote that line, so on a
// Mac the aliases could be simply missing after a successful setup. The PowerShell
// profile has had the equivalent since forever; POSIX never did.

test('the login shell decides which rc file is written', () => {
  assert.deepEqual(posixProfilePaths('/home/u', '/bin/zsh'), [path.join('/home/u', '.zshrc')]);
  assert.deepEqual(posixProfilePaths('/home/u', '/usr/local/bin/bash'), [path.join('/home/u', '.bashrc')]);
});

// Rather than write both files, an unknown shell falls to the platform default —
// zsh on macOS since Catalina, bash elsewhere.
test('an unrecognised or absent shell falls back to the platform default', () => {
  const fallback = posixProfilePaths('/home/u', '');
  assert.equal(fallback.length, 1);
  const expected = process.platform === 'darwin' ? '.zshrc' : '.bashrc';
  assert.equal(path.basename(fallback[0]), expected);
  assert.deepEqual(posixProfilePaths('/home/u', '/bin/fish'), fallback);
});

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-')); }

test('the source line is appended once, and only once', () => {
  const home = tmpHome();
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, 'export PATH="$HOME/bin:$PATH"\n');
  const before = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  try {
    installPosixProfileAliasSource(home);
    const once = fs.readFileSync(rc, 'utf8');
    assert.match(once, /\. ~\/\.claude\/scripts\/runtime\/aliases\.sh/);
    assert.match(once, /export PATH/, 'existing content must survive');

    installPosixProfileAliasSource(home);   // idempotent
    assert.equal(fs.readFileSync(rc, 'utf8'), once, 'a second run must not append again');
  } finally {
    if (before === undefined) delete process.env.SHELL; else process.env.SHELL = before;
  }
});

test('a profile that does not exist yet is created', () => {
  const home = tmpHome();
  const before = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  try {
    installPosixProfileAliasSource(home);
    assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /aliases\.sh/);
  } finally {
    if (before === undefined) delete process.env.SHELL; else process.env.SHELL = before;
  }
});

// The pre-`runtime/` layout is rewritten in place, mirroring the PowerShell branch.
test('a legacy source line is migrated, not duplicated', () => {
  const home = tmpHome();
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(rc, '. ~/.claude/scripts/shell/aliases.sh\n');
  const before = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  try {
    installPosixProfileAliasSource(home);
    const out = fs.readFileSync(rc, 'utf8');
    assert.match(out, /runtime\/aliases\.sh/);
    assert.doesNotMatch(out, /shell\/aliases\.sh/);
    assert.equal(out.match(/aliases\.sh/g).length, 1);
  } finally {
    if (before === undefined) delete process.env.SHELL; else process.env.SHELL = before;
  }
});
