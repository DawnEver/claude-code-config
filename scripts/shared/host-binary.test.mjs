import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { resolveHostBinary, envWithHostOnPath } from './host-binary.mjs';
import { tempDir } from './temp-dir.mjs';

// A fake Windows host: every input is injected, the live registry is never read.
function fakeHost() {
  const root = tempDir('host-binary-');
  const dir = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = { PATH: dir('proc'), PATHEXT: '.exe;.cmd', LOCALAPPDATA: dir('local'), USERPROFILE: dir('home') };
  return { root, dir, env };
}
const put = (d, file) => { fs.writeFileSync(path.join(d, file), ''); return path.join(d, file); };

test('found only via the registry user PATH, with its variables expanded', () => {
  const { dir, env } = fakeHost();
  const exe = put(dir('local', 'tools'), 'agy.exe');
  const registryPaths = () => ({ user: String.raw`%LOCALAPPDATA%\tools`, machine: '' });
  const found = resolveHostBinary('agy', { env, platform: 'win32', registryPaths });
  assert.equal(found.path, exe);
  assert.equal(found.source, 'registry user PATH');
});

test('found only via the standard install dir', () => {
  const { dir, env } = fakeHost();
  const exe = put(dir('local', 'agy', 'bin'), 'agy.exe');
  const found = resolveHostBinary('agy', { env, platform: 'win32', registryPaths: () => ({ user: '', machine: '' }) });
  assert.equal(found.path, exe);
  assert.equal(found.source, 'standard dir');
});

test('the process PATH wins over every later place', () => {
  const { dir, env } = fakeHost();
  const exe = put(env.PATH, 'agy.cmd');
  put(dir('local', 'agy', 'bin'), 'agy.exe');
  const found = resolveHostBinary('agy', { env, platform: 'win32', registryPaths: () => ({ user: '', machine: '' }) });
  assert.deepEqual([found.path, found.source], [exe, 'process PATH']);
});

test('absent everywhere is refused with every place searched', () => {
  const { env } = fakeHost();
  const registryPaths = () => ({ user: 'C:/nowhere-user', machine: 'C:/nowhere-machine' });
  const found = resolveHostBinary('agy', { env, platform: 'win32', registryPaths });
  assert.equal(found.path, null);
  for (const place of [env.PATH, 'C:/nowhere-user', 'C:/nowhere-machine', path.join(env.LOCALAPPDATA, 'agy', 'bin')]) {
    assert.ok(found.error.includes(place), `${place} missing from: ${found.error}`);
  }
  assert.match(found.error, /agy not found/);
});

test('off Windows the registry is never consulted', () => {
  const { env } = fakeHost();
  const found = resolveHostBinary('codex', { env: { PATH: env.PATH, HOME: env.USERPROFILE }, platform: 'linux',
    registryPaths: () => { throw new Error('registry read off Windows'); } });
  assert.equal(found.path, null);
});

test('a binary found off the process PATH puts its dir on the child PATH', () => {
  const { dir, env } = fakeHost();
  const bin = dir('local', 'agy', 'bin');
  put(bin, 'agy.exe');
  const out = envWithHostOnPath('agy', env, { platform: 'win32', registryPaths: () => ({ user: '', machine: '' }) });
  assert.equal(out.PATH.split(';')[0], bin);
  assert.equal(envWithHostOnPath('agy', { ...env, PATH: bin }, { platform: 'win32', registryPaths: () => ({}) }).PATH, bin);
});
