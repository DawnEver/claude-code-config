import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateCodexPlugins, inspectProtectedPluginCaches } from './update-codex-plugins.mjs';
import * as updater from './update-codex-plugins.mjs';

test('repair CLI restores protected files without a marketplace or native executable', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const target = path.join(f.version('rem', '1.0.0'), 'old.txt');
  fs.unlinkSync(target);
  const run = () => spawnSync(process.execPath,
    [fileURLToPath(new URL('./update-codex-plugins.mjs', import.meta.url)), '--repair'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: f.codexHome, PATH: '' } });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'repaired');
  assert.equal(fs.readFileSync(target, 'utf8'), 'rem:original bytes');
  fs.writeFileSync(path.join(f.codexHome, '.tmp', 'cc-config-plugin-update.lock'), 'existing owner');
  const busy = run();
  assert.equal(busy.status, 1);
  assert.equal(JSON.parse(busy.stdout).status, 'busy');
});

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

test('temporary marketplace readback cannot certify persistent activation', async t => {
  const f = fixture(t);
  const native = f.native();
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem'], run: async (command, args, options) => {
    if (args.includes('list') && !args.includes('-c')) return {
      status: 0, stdout: JSON.stringify({ installed: [{ pluginId: 'rem@cc-market', installed: true, enabled: true, version: '1.0.0' }] }),
    };
    return native(command, args, options);
  } }), /not registered at the expected version/);
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome).missing, []);
});

test('default-context readback preserves cache protection and rejects enablement drift', async t => {
  const f = fixture(t);
  const native = f.native();
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem'], run: async (command, args, options) => {
    const result = await native(command, args, options);
    if (args.includes('list') && !args.includes('-c')) {
      fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
      const data = JSON.parse(result.stdout);
      data.installed[0].enabled = false;
      return { ...result, stdout: JSON.stringify(data) };
    }
    return result;
  } }), /enablement differs/);
  assert.deepEqual(inspectProtectedPluginCaches(f.codexHome).missing, []);
});

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
  assert.equal(fs.existsSync(path.join(f.codexHome, 'config.toml')), false, 'preservation is not activation');
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

test('preservation-only repair restores missing paths but never replaces surviving files or activation', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const pointer = path.join(f.codexHome, '.tmp', 'cc-config-plugin-backup-pointer');
  const before = fs.readFileSync(pointer, 'utf8');
  const old = f.version('rem', '1.0.0');
  fs.unlinkSync(path.join(old, 'old.txt'));
  const result = updater.repairProtectedPluginCaches({ codexHome: f.codexHome });
  assert.equal(result.status, 'repaired');
  assert.equal(fs.readFileSync(path.join(old, 'old.txt'), 'utf8'), 'rem:original bytes');
  fs.writeFileSync(path.join(old, 'old.txt'), 'surviving bytes');
  updater.repairProtectedPluginCaches({ codexHome: f.codexHome });
  assert.equal(fs.readFileSync(path.join(old, 'old.txt'), 'utf8'), 'surviving bytes');
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'config.toml')), false);
});

test('preservation-only repair is nonblocking when busy and rejects invalid backup pointers', async t => {
  const f = fixture(t);
  assert.deepEqual(updater.repairProtectedPluginCaches({ codexHome: f.codexHome }), { status: 'no-backup', restored: [] });
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const old = f.version('rem', '1.0.0');
  fs.unlinkSync(path.join(old, 'old.txt'));
  const lock = path.join(f.codexHome, '.tmp', 'cc-config-plugin-update.lock');
  fs.writeFileSync(lock, 'owned by another update');
  assert.deepEqual(updater.repairProtectedPluginCaches({ codexHome: f.codexHome }), { status: 'busy', restored: [] });
  assert.equal(fs.existsSync(path.join(old, 'old.txt')), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'owned by another update');
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(f.codexHome, '.tmp', 'cc-config-plugin-backup-pointer'), f.root);
  assert.throws(() => updater.repairProtectedPluginCaches({ codexHome: f.codexHome }), /pointer/i);
  assert.equal(fs.existsSync(path.join(old, 'old.txt')), false);
  assert.equal(fs.existsSync(lock), false);
});

test('a failed new snapshot still repairs prior protected references deleted during the copy', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const pointer = path.join(f.codexHome, '.tmp', 'cc-config-plugin-backup-pointer');
  const before = fs.readFileSync(pointer, 'utf8');
  const original = fs.cpSync;
  let interrupted = false;
  t.mock.method(fs, 'cpSync', (source, target, options) => {
    if (!interrupted && source === f.version('rem', '2.0.0')) {
      interrupted = true;
      fs.unlinkSync(path.join(f.version('rem', '1.0.0'), 'old.txt'));
      throw Object.assign(new Error('native GC raced snapshot copy'), { code: 'ESRCH' });
    }
    return original(source, target, options);
  });
  await assert.rejects(updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => assert.fail('unexpected add')) }), /native GC/);
  assert.equal(interrupted, true);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
});

test('native list cleanup cannot delete references before the preservation snapshot is published', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const pointer = path.join(f.codexHome, '.tmp', 'cc-config-plugin-backup-pointer');
  const previous = fs.readFileSync(pointer, 'utf8');
  const native = f.native(() => {
    assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
    assert.equal(fs.existsSync(path.join(f.version('rem', '2.0.0'), '.codex-plugin', 'plugin.json')), true);
    return { status: 0 };
  });
  let reads = 0;
  const result = await updateCodexPlugins({ ...f, names: ['sharp-review'], run: async (command, args, options) => {
    if (args.includes('list')) {
      reads++;
      const backup = fs.readFileSync(pointer, 'utf8').trim();
      assert.notEqual(backup, previous.trim(), 'publish preservation before the first native read');
      assert.equal(fs.readFileSync(path.join(backup, 'rem', '1.0.0', 'old.txt'), 'utf8'), 'rem:original bytes');
      assert.equal(fs.existsSync(path.join(backup, 'rem', '2.0.0', '.codex-plugin', 'plugin.json')), true);
      fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
      fs.rmSync(f.version('rem', '2.0.0'), { recursive: true });
    }
    return native(command, args, options);
  } });
  assert.equal(reads, 3);
  assert.deepEqual(result.updated, ['sharp-review']);
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
  assert.equal(fs.existsSync(path.join(f.version('rem', '2.0.0'), '.codex-plugin', 'plugin.json')), true);
});

test('subsequent snapshots retain previous immutable bytes rather than rebaselining a survivor conflict', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const live = path.join(f.version('rem', '1.0.0'), 'old.txt');
  fs.writeFileSync(live, 'different surviving bytes');
  const result = await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => assert.fail('unexpected add')) });
  assert.equal(fs.readFileSync(path.join(result.backup, 'rem', '1.0.0', 'old.txt'), 'utf8'), 'rem:original bytes');
  assert.equal(fs.readFileSync(live, 'utf8'), 'different surviving bytes');
  assert.ok(inspectProtectedPluginCaches(f.codexHome).conflicts.some(item => item.name === 'rem' && item.version === '1.0.0' && item.file === 'old.txt'));
});

test('previous protected versions remain in the next snapshot when live inventory races deletion', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const read = fs.readdirSync;
  let removed = false;
  t.mock.method(fs, 'readdirSync', (dir, options) => {
    if (!removed && dir === path.dirname(f.version('rem', '1.0.0'))) {
      removed = true;
      fs.rmSync(f.version('rem', '1.0.0'), { recursive: true });
    }
    return read(dir, options);
  });
  const result = await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => assert.fail('unexpected add')) });
  assert.equal(removed, true);
  assert.equal(fs.readFileSync(path.join(result.backup, 'rem', '1.0.0', 'old.txt'), 'utf8'), 'rem:original bytes');
  assert.equal(fs.readFileSync(path.join(f.version('rem', '1.0.0'), 'old.txt'), 'utf8'), 'rem:original bytes');
});

test('quick repair checks immediate presence without claiming deep health; full repair restores nested losses', async t => {
  const f = fixture(t);
  const scripts = path.join(f.version('rem', '1.0.0'), 'scripts');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'entry.mjs'), 'nested runtime');
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  assert.deepEqual(updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick: true }), { status: 'not-needed', restored: [] });
  fs.unlinkSync(path.join(scripts, 'entry.mjs'));
  assert.deepEqual(updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick: true }), { status: 'not-needed', restored: [] });
  assert.equal(fs.existsSync(path.join(scripts, 'entry.mjs')), false);
  updater.repairProtectedPluginCaches({ codexHome: f.codexHome });
  assert.equal(fs.readFileSync(path.join(scripts, 'entry.mjs'), 'utf8'), 'nested runtime');
  fs.rmSync(scripts, { recursive: true });
  assert.equal(updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick: true }).status, 'repaired');
  assert.equal(fs.readFileSync(path.join(scripts, 'entry.mjs'), 'utf8'), 'nested runtime');
});

test('quick repair defers on its budget before unchecked writes, releases the lock, and permits full recovery', async t => {
  const f = fixture(t);
  const source = f.version('rem', '1.0.0');
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(source, `entry-${i}.mjs`), 'runtime');
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  fs.rmSync(source, { recursive: true });
  let time = 0;
  const result = updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick: true, budgetMs: 8, now: () => time++ });
  assert.equal(result.status, 'deferred');
  assert.equal(fs.existsSync(source), false, 'selected backup must validate before writes');
  assert.equal(fs.existsSync(path.join(f.codexHome, '.tmp', 'cc-config-plugin-update.lock')), false);
  assert.equal(updater.repairProtectedPluginCaches({ codexHome: f.codexHome }).status, 'repaired');
  assert.equal(fs.readFileSync(path.join(source, 'entry-19.mjs'), 'utf8'), 'runtime');
});

test('cache lock diagnostics are read-only and distinguish active, dead and unidentified owners', t => {
  const f = fixture(t), lock = path.join(f.codexHome, '.tmp', 'cc-config-plugin-update.lock');
  assert.deepEqual(updater.inspectPluginCacheLock({ codexHome: f.codexHome }), { status: 'absent' });
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');
  assert.equal(updater.inspectPluginCacheLock({ codexHome: f.codexHome }).status, 'unknown');
  assert.equal(fs.readFileSync(lock, 'utf8'), '');
  const owner = { pid: 12345, token: '11111111-2222-4333-8444-555555555555', startedAt: '2026-10-23T10:00:00.000Z' };
  const text = JSON.stringify(owner);
  fs.writeFileSync(lock, text);
  const options = { codexHome: f.codexHome, now: () => Date.parse(owner.startedAt) + 1234 };
  assert.deepEqual(updater.inspectPluginCacheLock({ ...options, isAlive: () => true }), { status: 'active', ...owner, ageMs: 1234 });
  assert.equal(updater.inspectPluginCacheLock({ ...options, isAlive: () => false }).status, 'inactive');
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
  assert.equal(updater.inspectPluginCacheLock(options).status, 'active');
  assert.equal(fs.readFileSync(lock, 'utf8'), text);
});

test('future update and repair locks record ownership and never release another owner token', async t => {
  const f = fixture(t), lock = path.join(f.codexHome, '.tmp', 'cc-config-plugin-update.lock');
  let owner;
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native(() => {
    owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.match(owner.token, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
    return { status: 0 };
  }) });
  assert.equal(fs.existsSync(lock), false);
  const replacement = { ...owner, token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  let first = true;
  updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick: true, now: () => {
    if (first) {
      first = false;
      const repairOwner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      assert.equal(repairOwner.pid, process.pid);
      assert.notEqual(repairOwner.token, owner.token);
      fs.writeFileSync(lock, JSON.stringify(replacement));
    }
    return 0;
  } });
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), replacement);
});

for (const quick of [false, true]) test(`interrupted staged cache copies never publish partial files (quick=${quick})`, async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const target = path.join(f.version('rem', '1.0.0'), 'old.txt');
  fs.unlinkSync(target);
  t.mock.method(fs, 'copyFileSync', (_from, to) => {
    fs.writeFileSync(to, 'partial');
    throw new Error('staging copy interrupted');
  });
  assert.throws(() => updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick }), /staging copy interrupted/);
  assert.equal(fs.existsSync(target), false);
  assert.ok(!fs.readdirSync(path.join(f.codexHome, '.tmp')).some(name => name.startsWith('cc-config-cache-restore-')));
  assert.equal(fs.existsSync(path.join(f.codexHome, '.tmp', 'cc-config-plugin-update.lock')), false);
});

for (const quick of [false, true]) test(`atomic cache publication preserves a concurrently recreated survivor (quick=${quick})`, async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const target = path.join(f.version('rem', '1.0.0'), 'old.txt');
  fs.unlinkSync(target);
  const link = fs.linkSync;
  let publication = false;
  t.mock.method(fs, 'linkSync', (from, to) => {
    publication = true;
    assert.equal(to, target);
    fs.writeFileSync(to, 'concurrent survivor');
    return link(from, to);
  });
  const result = updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick });
  assert.equal(publication, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent survivor');
  assert.deepEqual(result.restored, []);
  assert.ok(!fs.readdirSync(path.join(f.codexHome, '.tmp')).some(name => name.startsWith('cc-config-cache-restore-')));
});

test('quick budget expiry after staging removes its unpublished file and releases the lock', async t => {
  const f = fixture(t);
  await updateCodexPlugins({ ...f, names: ['rem'], run: f.native() });
  const target = path.join(f.version('rem', '1.0.0'), 'old.txt');
  fs.unlinkSync(target);
  const temp = path.join(f.codexHome, '.tmp');
  const result = updater.repairProtectedPluginCaches({ codexHome: f.codexHome, quick: true,
    now: () => fs.readdirSync(temp).some(name => name.startsWith('cc-config-cache-restore-')) ? 2000 : 0 });
  assert.equal(result.status, 'deferred');
  assert.equal(fs.existsSync(target), false);
  assert.ok(!fs.readdirSync(temp).some(name => name.startsWith('cc-config-cache-restore-')));
  assert.equal(fs.existsSync(path.join(temp, 'cc-config-plugin-update.lock')), false);
});
