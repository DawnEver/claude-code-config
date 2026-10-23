import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateCodexPlugins, inspectProtectedPluginCaches } from './update-codex-plugins.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'home');
  const marketplaceRoot = path.join(root, 'local marketplace');
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  const version = (name, v) => path.join(codexHome, 'plugins', 'cache', 'cc-market', name, v);
  for (const name of ['rem', 'sharp-review']) {
    fs.mkdirSync(path.join(marketplaceRoot, name, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(marketplaceRoot, name, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version: '2.0.0' }));
    fs.mkdirSync(version(name, '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(version(name, '1.0.0'), 'old.txt'), `${name}:original bytes`);
  }
  return { root, codexHome, marketplaceRoot, version };
}

test('native cleanup is restored after EACH add and snapshots remain unchanged', async t => {
  const f = fixture(t), calls = [];
  const result = await updateCodexPlugins({ ...f, names: ['rem', 'sharp-review'], run: (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 2) assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
    const name = args.find(a => /@cc-market$/.test(a)).split('@')[0];
    fs.rmSync(f.version(name, '1.0.0'), { recursive: true });
    fs.mkdirSync(f.version(name, '2.0.0'), { recursive: true });
    return { status: 0 };
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('marketplaces.cc-market.source_type=local'));
  assert.ok(calls[0].args.includes(`marketplaces.cc-market.source=${JSON.stringify(fs.realpathSync(f.marketplaceRoot))}`));
  assert.equal(calls[0].options.env.CODEX_HOME, fs.realpathSync(f.codexHome));
  for (const name of ['rem', 'sharp-review']) {
    const expected = `${name}:original bytes`;
    assert.equal(fs.readFileSync(path.join(f.version(name, '1.0.0'), 'old.txt'), 'utf8'), expected);
    assert.equal(fs.readFileSync(path.join(result.backup, name, '1.0.0', 'old.txt'), 'utf8'), expected);
  }
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome).missing, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.backup, 'snapshot.json'), 'utf8')),
    [{ name: 'rem', versions: ['1.0.0'] }, { name: 'sharp-review', versions: ['1.0.0'] }]);
});

test('an already cached release is skipped rather than overwritten by native add', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.version('rem', '2.0.0'));
  fs.writeFileSync(path.join(f.version('rem', '2.0.0'), 'keep.txt'), 'live target bytes');
  const result = await updateCodexPlugins({ ...f, names: ['rem'], run: () => assert.fail('reinstalled live release') });
  assert.deepEqual(result.skipped, ['rem']);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '2.0.0'), 'keep.txt'), 'utf8'), 'live target bytes');
});

test('failed native updates still restore missing references without overwriting existing cache content', async t => {
  const f = fixture(t);
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem', 'sharp-review'], run: () => {
    fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(f.version('sharp-review', '1.0.0'), 'old.txt'), 'native retained this');
    return { status: 1, stderr: 'mock install failed' };
  } }), /mock install failed/);
  const { backup, missing } = inspectProtectedPluginCaches(f.codexHome);
  assert.deepEqual(missing, []);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
  assert.equal(fs.readFileSync(path.join(f.version('sharp-review', '1.0.0'), 'old.txt'), 'utf8'), 'native retained this');
  assert.equal(fs.readFileSync(path.join(backup, 'sharp-review', '1.0.0', 'old.txt'), 'utf8'), 'sharp-review:original bytes');
});

test('doctor inspection is read-only and reports missing protected versions', async t => {
  const f = fixture(t);
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome), { missing: [] });
  await updateCodexPlugins({ ...f, names: ['rem'], run: () => ({ status: 0 }) });
  fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome).missing, [{ name: 'rem', version: '1.0.0' }]);
  assert.equal(fs.existsSync(f.version('rem', '1.0.0')), false);
});

test('partial native deletion leaves a version root but missing nested files are restored without replacing survivors', async t => {
  const f = fixture(t);
  const nested = path.join(f.version('rem', '1.0.0'), 'scripts');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'entry.mjs'), 'protected entry');
  await updateCodexPlugins({ ...f, names: ['rem'], run: () => {
    fs.rmSync(nested, { recursive: true });
    fs.writeFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'surviving open file');
    return { status: 0 };
  } });
  assert.equal(fs.readFileSync(path.join(nested, 'entry.mjs'), 'utf8'), 'protected entry');
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'surviving open file');
  fs.unlinkSync(path.join(nested, 'entry.mjs'));
  const check = inspectProtectedPluginCaches(f.codexHome);
  assert.deepEqual(check.missing, [{ name: 'rem', version: '1.0.0', file: path.join('scripts', 'entry.mjs') }]);
  assert.ok(check.conflicts.some(item => item.file === 'old.txt'));
});

test('names, snapshot traversal, and out-of-home cache links fail closed before invoking native CLI', async t => {
  const f = fixture(t);
  const run = () => assert.fail('unsafe native invocation');
  await assert.rejects(updateCodexPlugins({ ...f, names: ['../escape'], run }), /plugin name/);
  const tmp = path.join(f.codexHome, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const backup = path.join(tmp, 'cc-config-plugin-backup-fixture');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(tmp, 'cc-config-plugin-backup-pointer'), backup);
  fs.writeFileSync(path.join(backup, 'snapshot.json'), JSON.stringify([{ name: 'rem', versions: ['../escape'] }]));
  assert.throws(() => inspectProtectedPluginCaches(f.codexHome), /version/);
  fs.unlinkSync(path.join(tmp, 'cc-config-plugin-backup-pointer'));
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.version('rem', '3.0.0'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem'], run }), /outside|symlink/i);
});
