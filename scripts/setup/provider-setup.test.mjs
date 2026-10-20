import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { migrateApiKeysToStore, refreshProviderCache } from './provider-setup.mjs';
import { documentFor, fakeAiLab, writeCache } from '../shared/provider-cache-fixture.mjs';

// ── key migration: temp homes and a fake ai-lab only; the real store is never touched ──

function localFile(content) {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const path = join(home, 'claude_env_settings.local.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

const fakeAuth = (refuse = new Set()) => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts.input });
    return refuse.has(args[3])
      ? { status: 1, stderr: 'refused: api.x already holds this key as api-key (sha256 abcd...)\n' }
      : { status: 0, stdout: 'stored\n' };
  };
  return { run, calls };
};

test('migration stores each apiKey as the session key via stdin, backs up, then deletes the fields', () => {
  const path = localFile({ providers: { deepseek: { apiKey: 'sk-1' }, kimi: { apiKey: 'sk-2', other: 1 } }, bridge: { botToken: 't' } });
  const { run, calls } = fakeAuth();
  const res = migrateApiKeysToStore({ localPath: path, python: '/py', run });
  assert.equal(res.status, 'migrated');
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [
    ['/py', '-m', 'ai_lab.auth', 'login', 'deepseek', '--task', 'session'],
    ['/py', '-m', 'ai_lab.auth', 'login', 'kimi', '--task', 'session'],
  ]);
  assert.deepEqual(calls.map((c) => c.input), ['sk-1\n', 'sk-2\n']);
  assert.ok(calls.every((c) => !c.args.some((a) => a.startsWith('sk-'))), 'a key never travels in argv');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { providers: { kimi: { other: 1 } }, bridge: { botToken: 't' } });
  assert.equal(res.backupPath, `${path}.setup-bak`);
  assert.match(readFileSync(res.backupPath, 'utf8'), /sk-1/);
});

test('a refused key stays in the file; the stored ones go; the result carries no key', () => {
  const path = localFile({ providers: { deepseek: { apiKey: 'sk-1' }, kimi: { apiKey: 'sk-2' } } });
  const res = migrateApiKeysToStore({ localPath: path, python: '/py', run: fakeAuth(new Set(['kimi'])).run });
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.stored, ['deepseek']);
  assert.equal(res.failed[0].provider, 'kimi');
  assert.doesNotMatch(JSON.stringify(res.failed), /sk-/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { providers: { kimi: { apiKey: 'sk-2' } } });
});

test('an earlier backup is never overwritten', () => {
  const path = localFile({ providers: { deepseek: { apiKey: 'sk-1' } } });
  writeFileSync(`${path}.setup-bak`, 'older');
  const res = migrateApiKeysToStore({ localPath: path, python: '/py', run: fakeAuth().run });
  assert.equal(res.backupPath, `${path}.setup-bak.2`);
  assert.equal(readFileSync(`${path}.setup-bak`, 'utf8'), 'older');
});

test('nothing to migrate touches nothing', () => {
  const path = localFile({ bridge: {} });
  assert.equal(migrateApiKeysToStore({ localPath: path, python: '/py', run: () => assert.fail('no call') }).status, 'none');
  assert.equal(existsSync(`${path}.setup-bak`), false);
});

test('planted refusal: no Python leaves every key in place and names it', () => {
  const path = localFile({ providers: { deepseek: { apiKey: 'sk-1' } } });
  const enoent = () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  const res = migrateApiKeysToStore({ localPath: path, python: '/missing/py', run: enoent });
  assert.equal(res.status, 'failed');
  assert.match(res.failed[0].why, /^no Python: /);
  assert.match(migrateApiKeysToStore({ localPath: path, python: null }).failed[0].why, /^no Python/);
  assert.equal(existsSync(`${path}.setup-bak`), false);
});

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
