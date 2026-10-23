import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installCodexHooks, managedCodexHooks, inspectCodexHooks, hookDefinitionId } from './codex-hooks.mjs';

test('native hook installation preserves user handlers, is idempotent, and never trusts definitions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-review' }] }] } }));
  const options = { codexDir: dir, scriptsDir: '/local/scripts' };
  assert.equal(installCodexHooks(options).changed, true);
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.hooks.Stop[0].hooks[0].command, 'my-review');
  assert.equal(config.hooks.SessionStart.length, 1);
  assert.equal(config.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(installCodexHooks(options).changed, false);
  assert.deepEqual(inspectCodexHooks(options).installed, true);
  assert.equal(inspectCodexHooks(options).executed, false);
  assert.equal(fs.existsSync(path.join(dir, 'config.toml')), false);
  fs.mkdirSync(path.join(dir, 'harness-hooks'));
  fs.writeFileSync(path.join(dir, 'harness-hooks', 'SessionStart.json'), JSON.stringify({ definition: hookDefinitionId(options, 'SessionStart') }));
  assert.equal(inspectCodexHooks(options).events.SessionStart.executed, true);
  assert.equal(inspectCodexHooks(options).events.PreToolUse.executed, false);
  assert.equal(inspectCodexHooks(options).executed, false, 'startup never certifies a different event');
});

test('foreign empty handler groups are preserved', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ matcher: 'user-reserved', hooks: [] }] } }));
  installCodexHooks({ codexDir: dir, scriptsDir: '/scripts' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'))).hooks.Stop, [{ matcher: 'user-reserved', hooks: [] }]);
});

test('the generated command executes literal metacharacter paths without interpreting them', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-argv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptsDir = path.join(dir, 'a $(never-run) `literal` path');
  fs.mkdirSync(path.join(scriptsDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'hooks', 'codex-hook.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  const command = managedCodexHooks({ scriptsDir }).PreToolUse[0].hooks[0].command;
  const output = process.platform === 'win32'
    ? execSync(command, { encoding: 'utf8', windowsHide: true })
    : execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  const args = JSON.parse(output);
  assert.deepEqual(args.slice(0, 3), ['--event', 'PreToolUse', '--definition']);
  assert.match(args[3], /^[a-f0-9]{64}$/);
});

test('generated real native entry records only the actual invoked event in an isolated home', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { codexDir: dir, scriptsDir: fileURLToPath(new URL('../', import.meta.url)) };
  installCodexHooks(options);
  const command = managedCodexHooks(options).PreToolUse[0].hooks[0].command;
  const output = execSync(command, { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CODEX_HOME: dir, CODEX_THREAD_ID: 'native-entry-fixture' },
    input: JSON.stringify({ tool_name: 'write_stdin', session_id: 'root-fixture' }) });
  assert.deepEqual(JSON.parse(output), {});
  const state = inspectCodexHooks(options);
  assert.equal(state.events.PreToolUse.executed, true);
  assert.equal(state.events.SessionStart.executed, false);
  assert.equal(state.executed, false);
});

test('malformed and symlinked user hooks are never overwritten', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, '{bad');
  assert.throws(() => installCodexHooks({ codexDir: dir, scriptsDir: '/scripts' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('all commands pass dangerous local paths only as encoded argv data', () => {
  const script = '/a path/$(never-run)`literal`/scripts';
  const hooks = managedCodexHooks({ scriptsDir: script, node: '/node path/node' });
  const command = hooks.SessionStart[0].hooks[0].command;
  assert.doesNotMatch(command, /\$\(|`literal`/);
  const encoded = /Buffer.from\('([^']+)'/.exec(command)[1];
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64').toString())[1], path.join(script, 'hooks', 'codex-hook.mjs'));
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'PreToolUse', 'PermissionRequest', 'SessionEnd']);
});
