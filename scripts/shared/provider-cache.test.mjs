import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiLabVersionOnDisk, readProviderCache, recordedPython, writeProviderCache, SETUP_REMEDY,
} from './provider-cache.mjs';
import { catalogueDoc, documentFor, fakeAiLab, writeCache } from './provider-cache-fixture.mjs';

test('a fresh cache with matching inputs and version is current', () => {
  const lab = fakeAiLab();
  const { cache, error } = readProviderCache({ path: writeCache(lab) });
  assert.equal(error, undefined);
  assert.equal(cache.providers.deepseek.endpoints.anthropic, 'https://api.deepseek.com/anthropic');
});

test('an absent cache refuses and names the remedy', () => {
  const lab = fakeAiLab();
  const { error } = readProviderCache({ path: join(lab.dir, 'nope.json') });
  assert.match(error, /is absent/);
  assert.ok(error.includes(SETUP_REMEDY));
});

test('stale (a): an edited providers.toml input refuses', () => {
  const lab = fakeAiLab();
  const path = writeCache(lab);
  writeFileSync(lab.packaged, '[deepseek]\nurl = "https://elsewhere"\n');
  assert.match(readProviderCache({ path }).error, /inputs changed/);
});

test('stale (a): a user providers.toml appearing after setup refuses', () => {
  const lab = fakeAiLab();
  const path = writeCache(lab);
  writeFileSync(lab.user, '[mine]\nurl = "https://x"\n');
  assert.match(readProviderCache({ path }).error, /inputs changed/);
});

test('stale (b): a different installed ai-lab version refuses, naming both', () => {
  const lab = fakeAiLab({ version: '9.9.9' });
  const { error } = readProviderCache({ path: writeCache(lab) });
  assert.match(error, /ai-lab 9\.9\.9 .* is not the recorded/);
});

test('stale (c): older than the max age refuses', () => {
  const lab = fakeAiLab();
  const old = new Date(Date.now() - 8 * 86400000);
  assert.match(readProviderCache({ path: writeCache(lab, documentFor(lab, old)) }).error, /older than 7 d/);
});

test('an unknown schema_version refuses', () => {
  const lab = fakeAiLab();
  const doc = { ...documentFor(lab), schema_version: 2 };
  assert.match(readProviderCache({ path: writeCache(lab, doc) }).error, /schema_version 2/);
});

test('the installed version is read from the venv dist-info', () => {
  const lab = fakeAiLab({ version: '1.2.3' });
  assert.equal(aiLabVersionOnDisk(lab.python), '1.2.3');
  assert.equal(aiLabVersionOnDisk(join(lab.dir, 'other', 'bin', 'python')), null);
});

test('setup writes the cache from ai_lab.providers --json and records the interpreter', () => {
  const lab = fakeAiLab();
  const path = join(lab.dir, 'out', 'provider-cache.json');
  const doc = documentFor(lab);
  let called;
  const run = (cmd, args) => { called = [cmd, ...args]; return { status: 0, stdout: JSON.stringify(doc), stderr: '' }; };
  const res = writeProviderCache({ python: lab.python, path, run });
  assert.equal(res.ok, true);
  assert.deepEqual(called, [lab.python, '-m', 'ai_lab.providers', '--json']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), doc);
  assert.equal(recordedPython(path), lab.python);
});

test('planted refusal: no Python refuses by name and writes nothing', () => {
  const lab = fakeAiLab();
  const path = join(lab.dir, 'provider-cache.json');
  const run = () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  assert.match(writeProviderCache({ python: lab.python, path, run }).error, /^no Python: /);
  assert.match(writeProviderCache({ python: null, path, run }).error, /^no Python for ai-lab: pass --ai-lab-python/);
  assert.equal(existsSync(path), false);
});

test('no ai-lab beside the interpreter refuses by name', () => {
  const lab = fakeAiLab();
  const run = () => ({ status: 1, stdout: '', stderr: "No module named ai_lab.providers\n" });
  assert.match(writeProviderCache({ python: lab.python, path: join(lab.dir, 'c.json'), run }).error,
    /^no ai-lab: .*No module named ai_lab\.providers/);
});

test('the fixture carries no key, only usernames', () => {
  const text = JSON.stringify(catalogueDoc());
  assert.doesNotMatch(text, /sk-|apiKey|password/i);
});
