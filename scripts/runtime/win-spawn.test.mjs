import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { escapeArgument, escapeCommand, buildSpawn, resolveCommand, prepareSpawn } from './win-spawn.mjs';

const WIN = { platform: 'win32', comspec: 'cmd.exe' };
/** The command line cmd.exe actually receives, minus the /d /s /c wrapper. */
const line = r => r.args[3];

test('non-Windows passes command and args through untouched', () => {
  const r = buildSpawn({ command: 'codex', args: ['exec', 'Reply with spaces'], platform: 'darwin' });
  assert.equal(r.command, 'codex');
  assert.deepEqual(r.args, ['exec', 'Reply with spaces']);
  assert.deepEqual(r.options, {});
});

test('a resolved .exe is spawned directly — no shell, no escaping', () => {
  const r = buildSpawn({ command: 'C:\\tools\\codex.exe', args: ['exec', 'a b'], ...WIN });
  assert.equal(r.command, 'C:\\tools\\codex.exe');
  assert.deepEqual(r.args, ['exec', 'a b']);
  assert.equal(r.options.windowsVerbatimArguments, undefined);
});

test('a .cmd shim goes through cmd.exe with /d /s /c and verbatim args', () => {
  const r = buildSpawn({ command: 'C:\\npm\\codex.cmd', args: ['exec'], ...WIN });
  assert.equal(r.command, 'cmd.exe');
  assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(r.options.windowsVerbatimArguments, true);
  // The whole line is wrapped in the quote pair that /s strips.
  assert.ok(line(r).startsWith('"') && line(r).endsWith('"'));
});

test('the regression: spaces inside one argument are escaped, not left as separators', () => {
  const r = buildSpawn({ command: 'C:\\npm\\codex.cmd', args: ['exec', 'Reply with exactly: OK1'], ...WIN });
  // Previously the args were concatenated raw, so cmd saw `with` as its own token and
  // Codex reported: error: unexpected argument 'with' found.
  const body = line(r).slice(1, -1); // drop the /s wrapper quotes
  assert.equal((body.match(/(?<!\^)\s/g) || []).length, 2, 'only the two real argv separators stay bare');
});

test('cmd metacharacters in a prompt are escaped, not interpreted', () => {
  for (const meta of ['&', '|', '>', '<', '(', ')', '%', '^']) {
    const r = buildSpawn({ command: 'C:\\npm\\codex.cmd', args: [`a${meta}b`], ...WIN });
    assert.ok(line(r).includes(`^^^${meta}`), `${meta} should be escaped for a .cmd shim`);
  }
});

test('a chained command in a prompt cannot break out and run', () => {
  const r = buildSpawn({ command: 'C:\\npm\\codex.cmd', args: ['exec', 'hi & calc.exe'], ...WIN });
  // No bare & survives as a command separator: each is preceded by a caret.
  assert.equal((line(r).match(/(?<!\^)&/g) || []).length, 0);
});

test('escapeArgument: quotes, trailing backslashes, and single vs double escaping', () => {
  assert.equal(escapeArgument('a&b', false), '^"a^&b^"');
  assert.equal(escapeArgument('a&b', true), '^^^"a^^^&b^^^"');
  // Inner quotes become literal via backslash; the caret is cmd's layer on top.
  assert.equal(escapeArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"');
  // The trailing backslash is doubled so it cannot escape the closing quote.
  assert.equal(escapeArgument('C:\\path\\', false), '^"C:\\path\\\\^"');
});

test('escapeCommand escapes spaces so an unquoted path survives', () => {
  assert.equal(escapeCommand('C:\\Program Files\\x.cmd'), 'C:\\Program^ Files\\x.cmd');
});

test('resolveCommand returns null for a binary that is not on PATH', () => {
  const r = resolveCommand('definitely-not-a-real-binary-xyz', {
    env: { PATH: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
    platform: 'win32',
  });
  assert.equal(r, null);
});

test('prepareSpawn falls back to the plain name when the binary is not on PATH', () => {
  const r = prepareSpawn('nope-not-here-xyz', ['a b'], {
    env: { PATH: '', PATHEXT: '.CMD' },
    platform: 'win32',
  });
  assert.equal(r.command, 'nope-not-here-xyz');
  assert.equal(r.options.shell, true);
});

// The escaping above is only as good as cmd.exe's actual parsing, so drive a real .cmd
// shim — the same shape npm generates for `codex` / `claude` — and compare what argv it
// received against what we asked for.
test('round-trip through a real .cmd shim preserves argv exactly', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'win-spawn-'));
  try {
    writeFileSync(join(dir, 'argecho.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    // Mirrors the npm shim: a .cmd that forwards %* to a node script.
    writeFileSync(join(dir, 'argecho.cmd'), '@ECHO off\r\nnode "%~dp0argecho.mjs" %*\r\n');

    const cases = [
      ['exec', 'Reply with exactly: OK1'],
      ['a&b'],
      ['say "hi"'],
      ['100% budget & <x> | y'],
      ['C:\\path\\'],
      ['multi  internal   spaces'],
      ['(parens) [brackets] ^caret'],
      ['exec', '--flag=value with space'],
    ];

    for (const args of cases) {
      const s = buildSpawn({ command: join(dir, 'argecho.cmd'), args, platform: 'win32' });
      const res = spawnSync(s.command, s.args, { ...s.options, encoding: 'utf8' });
      assert.equal(res.status, 0, `spawn failed for ${JSON.stringify(args)}: ${res.stderr}`);
      assert.deepEqual(JSON.parse(res.stdout.trim()), args, `argv mismatch for ${JSON.stringify(args)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
