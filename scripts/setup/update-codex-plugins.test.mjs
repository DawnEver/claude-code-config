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
  const registered = new Map();
  for (const name of ['rem', 'sharp-review']) {
    fs.mkdirSync(path.join(marketplaceRoot, name, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(marketplaceRoot, name, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version: '2.0.0' }));
    fs.mkdirSync(version(name, '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(version(name, '1.0.0'), 'old.txt'), `${name}:original bytes`);
  }
  const register = (name, enabled = true, version = '2.0.0') => registered.set(name, { pluginId: `${name}@cc-market`, version, installed: true, enabled });
  const install = name => {
    fs.cpSync(path.join(marketplaceRoot, name), version(name, '2.0.0'), { recursive: true });
    register(name);
  };
  const native = (add = () => ({ status: 0 }), { installs = true } = {}) => async (command, args, options) => {
    if (args.includes('list')) return { status: 0, stdout: JSON.stringify({ installed: [...registered.values()] }) };
    const result = await add(command, args, options);
    if (result.status === 0 && installs) install(args.find(a => /@cc-market$/.test(a)).split('@')[0]);
    return result;
  };
  return { root, codexHome, marketplaceRoot, version, native, install, register };
}

test('native cleanup is restored after EACH add and snapshots remain unchanged', async t => {
  const f = fixture(t), calls = [];
  const result = await updateCodexPlugins({ ...f, names: ['rem', 'sharp-review'], run: f.native((command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 2) assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
    const name = args.find(a => /@cc-market$/.test(a)).split('@')[0];
    fs.rmSync(f.version(name, '1.0.0'), { recursive: true });
    fs.mkdirSync(f.version(name, '2.0.0'), { recursive: true });
    return { status: 0 };
  }) });
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
  f.install('rem');
  fs.writeFileSync(path.join(f.version('rem', '2.0.0'), 'keep.txt'), 'live target bytes');
  const result = await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => assert.fail('reinstalled live release')) });
  assert.deepEqual(result.skipped, ['rem']);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '2.0.0'), 'keep.txt'), 'utf8'), 'live target bytes');
});

test('failed native updates still restore missing references without overwriting existing cache content', async t => {
  const f = fixture(t);
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem', 'sharp-review'], run: f.native(() => {
    fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(f.version('sharp-review', '1.0.0'), 'old.txt'), 'native retained this');
    return { status: 1, stderr: 'mock install failed' };
  }) }), /mock install failed/);
  const { backup, missing } = inspectProtectedPluginCaches(f.codexHome);
  assert.deepEqual(missing, []);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
  assert.equal(fs.readFileSync(path.join(f.version('sharp-review', '1.0.0'), 'old.txt'), 'utf8'), 'native retained this');
  assert.equal(fs.readFileSync(path.join(backup, 'sharp-review', '1.0.0', 'old.txt'), 'utf8'), 'sharp-review:original bytes');
});

test('doctor inspection is read-only and reports missing protected versions', async t => {
  const f = fixture(t);
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome), { missing: [] });
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome).missing, [{ name: 'rem', version: '1.0.0' }]);
  assert.equal(fs.existsSync(f.version('rem', '1.0.0')), false);
});

test('partial native deletion leaves a version root but missing nested files are restored without replacing survivors', async t => {
  const f = fixture(t);
  const nested = path.join(f.version('rem', '1.0.0'), 'scripts');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'entry.mjs'), 'protected entry');
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => {
    fs.rmSync(nested, { recursive: true });
    fs.writeFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'surviving open file');
    return { status: 0 };
  }) });
  assert.equal(fs.readFileSync(path.join(nested, 'entry.mjs'), 'utf8'), 'protected entry');
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'surviving open file');
  fs.unlinkSync(path.join(nested, 'entry.mjs'));
  const check = inspectProtectedPluginCaches(f.codexHome);
  assert.deepEqual(check.missing, [{ name: 'rem', version: '1.0.0', file: path.join('scripts', 'entry.mjs') }]);
  assert.ok(check.conflicts.some(item => item.file === 'old.txt'));
});

test('partial and unregistered immutable target caches fail closed without native add', async t => {
  const f = fixture(t);
  const options = { ...f, names: ['rem'], run: f.native(() => assert.fail('modified existing target')) };
  fs.mkdirSync(f.version('rem', '2.0.0'));
  fs.writeFileSync(path.join(f.version('rem', '2.0.0'), 'keep.txt'), 'immutable');
  await assert.rejects(updateCodexPlugins(options), /manifest|incomplete/i);
  f.install('rem');
  fs.mkdirSync(path.join(f.marketplaceRoot, 'rem', 'scripts'));
  fs.writeFileSync(path.join(f.marketplaceRoot, 'rem', 'scripts', 'entry.mjs'), 'runtime');
  await assert.rejects(updateCodexPlugins(options), /incomplete|missing/i);
  fs.cpSync(path.join(f.marketplaceRoot, 'rem'), f.version('rem', '2.0.0'), { recursive: true });
  const unregistered = async () => ({ status: 0, stdout: JSON.stringify({ installed: [] }) });
  await assert.rejects(updateCodexPlugins({ ...options, run: unregistered }), /registered|registration/i);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '2.0.0'), 'keep.txt'), 'utf8'), 'immutable');
});

test('native success without an actual installation is not reported as updated', async t => {
  const f = fixture(t);
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem'], run: f.native(undefined, { installs: false }) }), /manifest|incomplete|missing/i);
});

test('a registered disabled target is preserved without enabling it', async t => {
  const f = fixture(t);
  f.install('rem');
  f.register('rem', false);
  const result = await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => assert.fail('enabled existing target')) });
  assert.deepEqual(result.skipped, ['rem']);
  assert.deepEqual(result.disabled, ['rem']);
});

test('an older disabled registration blocks the entire update before any native add', async t => {
  const f = fixture(t);
  f.register('rem', false, '1.0.0');
  await assert.rejects(updateCodexPlugins({ ...f, names: ['sharp-review', 'rem'], run: f.native(() => assert.fail('unexpected native add')) }), /disabled/i);
  assert.equal(fs.existsSync(f.version('rem', '2.0.0')), false);
  assert.equal(fs.existsSync(f.version('sharp-review', '2.0.0')), false);
  assert.equal(fs.existsSync(path.join(f.codexHome, '.tmp', 'cc-config-plugin-backup-pointer')), false);
});

test('native add must register the installed version and readback retains local overrides', async t => {
  const f = fixture(t);
  const calls = [];
  const run = f.native();
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem'], run: async (command, args, options) => {
    if (args.includes('list')) {
      calls.push(args);
      assert.equal(options.env.CODEX_HOME, fs.realpathSync(f.codexHome));
      assert.ok(args.includes('marketplaces.cc-market.source_type=local'));
      assert.ok(args.includes(`marketplaces.cc-market.source=${JSON.stringify(fs.realpathSync(f.marketplaceRoot))}`));
      assert.ok(args.includes('--marketplace'));
      return { status: 0, stdout: JSON.stringify({ installed: [{ pluginId: 'rem@cc-market', installed: true, version: '1.0.0' }] }) };
    }
    return run(command, args, options);
  } }), /registered|registration/i);
  assert.equal(calls.length, 2);
});

test('source-only development metadata is not required in an immutable runtime cache', async t => {
  const f = fixture(t);
  f.install('rem');
  for (const dir of ['tests', '.claude', 'node_modules', '.venv', '__pycache__']) {
    fs.mkdirSync(path.join(f.marketplaceRoot, 'rem', dir));
    fs.writeFileSync(path.join(f.marketplaceRoot, 'rem', dir, 'development-only'), 'not shipped');
  }
  const result = await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => assert.fail('reinstalled existing cache')) });
  assert.deepEqual(result.skipped, ['rem']);
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
