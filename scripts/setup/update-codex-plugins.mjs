#!/usr/bin/env node
// Explicit native updates with preservation of immutable cache paths held by live sessions.
// Native updates are never automatic; hooks use the separate preservation-only repair API.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isMain } from '../shared/is-main.mjs';
import { resolveCodexHome } from '../shared/codex-home.mjs';
import { prepareSpawn, resolveCommand } from '../runtime/win-spawn.mjs';

const NAME = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const POINTER = 'cc-config-plugin-backup-pointer';
const PREFIX = 'cc-config-plugin-backup-';
const exists = file => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;

function releaseCacheLock({ file, fd, token }) {
  fs.closeSync(fd);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
  } catch { /* Unknown or replaced owner: never delete its lock. */ }
}

function acquireCacheLock(home) {
  const file = owned(home, '.tmp', 'cc-config-plugin-update.lock');
  const lock = { file, fd: fs.openSync(file, 'wx'), token: randomUUID() };
  try {
    fs.writeFileSync(lock.fd, JSON.stringify({ pid: process.pid, token: lock.token, startedAt: new Date().toISOString() }));
    return lock;
  } catch (error) { releaseCacheLock(lock); throw error; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM is not evidence of death.
}

/** Read-only diagnostics. Even a confirmed dead owner never authorizes automatic stealing. */
export function inspectPluginCacheLock({ codexHome = resolveCodexHome(), isAlive = pidAlive, now = Date.now } = {}) {
  if (!exists(codexHome)) return { status: 'absent' };
  const home = fs.realpathSync(codexHome);
  const file = owned(home, '.tmp', 'cc-config-plugin-update.lock');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return { status: error.code === 'ENOENT' ? 'absent' : 'unknown' }; }
  let owner;
  try { owner = JSON.parse(text); } catch { return { status: 'unknown' }; }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.token) ||
      typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))) return { status: 'unknown' };
  return { status: isAlive(owner.pid) ? 'active' : 'inactive', pid: owner.pid, token: owner.token,
    startedAt: owner.startedAt, ageMs: Math.max(0, now() - Date.parse(owner.startedAt)) };
}

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Plugin update path resolves outside its owned directory');
  return target;
}

/** Validate both lexical path and the real nearest ancestor before writing anything. */
function owned(root, ...parts) {
  const target = assertWithin(root, path.resolve(root, ...parts));
  let ancestor = target;
  while (!exists(ancestor)) ancestor = path.dirname(ancestor);
  assertWithin(root, fs.realpathSync(ancestor));
  return target;
}

function valid(value, pattern, kind) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid plugin ${kind}`);
  return value;
}

// Copying link targets is safe only after checking the whole source tree. Snapshots
// contain ordinary files/directories, never links back to a vendor-managed cache.
function validateTree(root, dir, ancestors = new Set(), checkpoint = () => {}) {
  checkpoint();
  const real = assertWithin(root, fs.realpathSync(dir));
  if (ancestors.has(real)) throw new Error('Cyclic plugin cache symlink');
  if (!fs.statSync(dir).isDirectory()) throw new Error('Plugin cache version is not a directory');
  const next = new Set(ancestors).add(real);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    checkpoint();
    const file = path.join(dir, entry.name);
    assertWithin(root, fs.realpathSync(file));
    if (fs.statSync(file).isDirectory()) validateTree(root, file, next, checkpoint);
    else if (!fs.statSync(file).isFile()) throw new Error('Unsupported plugin cache file type');
  }
}

function protectedSnapshot(home, { validateVersions = true, checkpoint = () => {} } = {}) {
  checkpoint();
  const pointer = owned(home, '.tmp', POINTER);
  if (!exists(pointer)) return null;
  const backup = fs.readFileSync(pointer, 'utf8').trim();
  const temp = owned(home, '.tmp');
  if (!path.isAbsolute(backup) || path.dirname(backup) !== temp || !path.basename(backup).startsWith(PREFIX))
    throw new Error('Invalid protected plugin backup pointer');
  owned(home, path.relative(home, backup));
  const snapshot = JSON.parse(fs.readFileSync(owned(backup, 'snapshot.json'), 'utf8'));
  if (!Array.isArray(snapshot)) throw new Error('Invalid plugin snapshot');
  const names = new Set();
  for (const item of snapshot) {
    checkpoint();
    valid(item?.name, NAME, 'name');
    if (names.has(item.name) || !Array.isArray(item.versions)) throw new Error('Invalid plugin snapshot');
    names.add(item.name);
    for (const version of item.versions) {
      checkpoint();
      valid(version, VERSION, 'version');
      const source = owned(backup, item.name, version);
      if (validateVersions) validateTree(backup, source, new Set(), checkpoint);
      owned(home, 'plugins', 'cache', 'cc-market', item.name, version);
    }
  }
  return { backup, snapshot };
}

/** Read-only doctor input. Invalid metadata throws; a missing pointer is not an error. */
export function inspectProtectedPluginCaches(codexHome = resolveCodexHome()) {
  if (!exists(codexHome)) return { missing: [] };
  const home = fs.realpathSync(codexHome);
  const data = protectedSnapshot(home);
  if (!data) return { missing: [] };
  const missing = [], conflicts = [];
  for (const { name, versions } of data.snapshot) for (const version of versions) {
    const target = owned(home, 'plugins', 'cache', 'cc-market', name, version);
    if (!exists(target)) { missing.push({ name, version }); continue; }
    const source = owned(data.backup, name, version);
    const walk = (from, to, relative = '') => {
      if (!exists(to)) { missing.push({ name, version, file: relative }); return; }
      owned(home, path.relative(home, to));
      if (fs.statSync(from).isDirectory()) {
        if (!fs.statSync(to).isDirectory()) { conflicts.push({ name, version, file: relative }); return; }
        for (const entry of fs.readdirSync(from)) walk(path.join(from, entry), path.join(to, entry), path.join(relative, entry));
      } else if (!fs.statSync(to).isFile() || !fs.readFileSync(from).equals(fs.readFileSync(to))) conflicts.push({ name, version, file: relative });
    };
    walk(source, target);
  }
  return { missing, backup: data.backup, ...(conflicts.length ? { conflicts } : {}) };
}

function publishRestoredFile(home, source, target, checkpoint) {
  const staging = owned(home, '.tmp', `cc-config-cache-restore-${randomUUID()}.tmp`);
  // Reserve our own staging path first; interrupted copies never appear in a live cache.
  fs.closeSync(fs.openSync(staging, 'wx', 0o600));
  try {
    fs.copyFileSync(source, staging);
    fs.chmodSync(staging, fs.statSync(source).mode & 0o777);
    checkpoint();
    try { fs.linkSync(staging, target); return true; }
    catch (error) {
      if (error.code === 'EEXIST') return false; // A concurrent survivor always wins.
      throw error; // Never fall back to an overwriting rename or direct destination copy.
    }
  } finally { fs.unlinkSync(staging); }
}

function restore(home, { backup, snapshot }, { checkpoint = () => {}, validated = false, restored = [] } = {}) {
  for (const { name, versions } of snapshot) for (const version of versions) {
    checkpoint();
    const target = owned(home, 'plugins', 'cache', 'cc-market', name, version);
    const source = owned(backup, name, version);
    if (!validated) validateTree(backup, source, new Set(), checkpoint);
    checkpoint();
    fs.mkdirSync(owned(home, 'plugins', 'cache', 'cc-market', name), { recursive: true });
    const fill = (from, to, relative = '') => {
      checkpoint();
      owned(home, path.relative(home, to));
      if (!exists(to)) {
        if (fs.statSync(from).isDirectory()) {
          fs.mkdirSync(to, { recursive: true });
          for (const entry of fs.readdirSync(from)) fill(path.join(from, entry), path.join(to, entry), path.join(relative, entry));
        } else {
          if (publishRestoredFile(home, from, to, checkpoint))
            restored.push({ name, version, ...(relative ? { file: relative } : {}) });
        }
      } else if (fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) {
        for (const entry of fs.readdirSync(from)) fill(path.join(from, entry), path.join(to, entry), path.join(relative, entry));
      }
      // Surviving bytes are immutable too. A mismatch is reported by inspection, never overwritten.
    };
    fill(source, target);
  }
  return restored;
}

/** Preservation only: no vendor calls, new snapshots, activation changes or survivor replacement. */
export function repairProtectedPluginCaches({ codexHome = resolveCodexHome(), quick = false, budgetMs = 1000, now = () => performance.now() } = {}) {
  if (!exists(codexHome)) return { status: 'no-backup', restored: [] };
  const home = fs.realpathSync(codexHome);
  if (!exists(owned(home, '.tmp', POINTER))) return { status: 'no-backup', restored: [] };
  let lock;
  try { lock = acquireCacheLock(home); }
  catch (error) {
    if (error.code === 'EEXIST') return { status: 'busy', restored: [] };
    throw error;
  }
  const expired = Symbol('repair budget expired');
  const deadline = quick ? now() + budgetMs : Infinity;
  const checkpoint = () => { if (quick && now() >= deadline) throw expired; };
  const restored = [];
  try {
    const data = protectedSnapshot(home, { validateVersions: !quick, checkpoint });
    if (!data) return { status: 'no-backup', restored: [] };
    if (quick) {
      // Before-tool checking is deliberately shallow, not an integrity certificate.
      // Startup/full repair and doctor still cover missing files deeper in a survivor.
      data.snapshot = data.snapshot.map(({ name, versions }) => ({ name, versions: versions.filter(version => {
        checkpoint();
        const source = owned(data.backup, name, version);
        const target = owned(home, 'plugins', 'cache', 'cc-market', name, version);
        if (!fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) return true;
        return fs.readdirSync(source, { withFileTypes: true }).some(entry => {
          checkpoint();
          const from = owned(data.backup, name, version, entry.name);
          const to = owned(home, 'plugins', 'cache', 'cc-market', name, version, entry.name);
          const expected = fs.statSync(from), actual = fs.statSync(to, { throwIfNoEntry: false });
          return !actual || expected.isDirectory() !== actual.isDirectory() || expected.isFile() !== actual.isFile();
        });
      }) })).filter(item => item.versions.length);
      if (!data.snapshot.length) return { status: 'not-needed', restored: [] };
      // Validate every selected backup before creating even one cache directory.
      for (const { name, versions } of data.snapshot) for (const version of versions)
        validateTree(data.backup, owned(data.backup, name, version), new Set(), checkpoint);
    }
    return { status: 'repaired', restored: restore(home, data, { checkpoint, validated: quick, restored }) };
  } catch (error) {
    if (error === expired) return { status: 'deferred', restored };
    throw error;
  } finally { releaseCacheLock(lock); }
}

function nativeRun(command, args, { env }) {
  const binary = resolveCommand(command, { env });
  if (!binary) throw new Error('codex executable not found on PATH');
  const launch = prepareSpawn(binary, args, { env });
  return spawnSync(launch.command, launch.args, { ...launch.options, env, windowsHide: true,
    encoding: 'utf8', timeout: 120000 });
}

// Source files are an inventory, not replacement bytes: an occupied version is immutable.
const DEV_ONLY = new Set(['.git', '.claude', 'node_modules', 'tests', '__pycache__', '.pytest_cache', '.ruff_cache', '.venv', '_meta.json', '.DS_Store']);
function requirePayload(market, home, name, version) {
  const source = owned(market, name);
  const target = owned(home, 'plugins', 'cache', 'cc-market', name, version);
  const fail = detail => { throw new Error(`Plugin ${name}@${version} cache is incomplete (${detail}); existing versions are immutable. Close clients and reconcile explicitly or release a new version.`); };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(owned(home, path.relative(home, path.join(target, '.codex-plugin', 'plugin.json'))), 'utf8')); }
  catch { fail('missing or invalid native manifest'); }
  if (manifest?.name !== name || manifest?.version !== version) fail('native manifest name/version mismatch');
  const walk = (from, to) => {
    owned(market, path.relative(market, from));
    owned(home, path.relative(home, to));
    const stat = fs.statSync(from), actual = fs.statSync(to, { throwIfNoEntry: false });
    if (stat.isDirectory()) {
      if (!actual?.isDirectory()) fail(`missing directory ${path.relative(target, to)}`);
      for (const entry of fs.readdirSync(from)) if (!DEV_ONLY.has(entry)) walk(path.join(from, entry), path.join(to, entry));
    } else if (!stat.isFile() || !actual?.isFile()) fail(`missing file ${path.relative(target, to)}`);
  };
  walk(source, target);
}

async function registrations(run, args, env) {
  const result = await run('codex', [...args, 'plugin', 'list', '--marketplace', 'cc-market', '--json'], { env });
  if (result?.error) throw result.error;
  if (result?.status !== 0) throw new Error('Unable to verify native plugin registration');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('Invalid native plugin registration response'); }
  if (!Array.isArray(data?.installed)) throw new Error('Invalid native plugin registration response');
  return data.installed;
}

function requireRegistration(installed, name, version) {
  const entry = installed.find(item => item.pluginId === `${name}@cc-market` && item.installed === true && item.version === version);
  if (!entry) throw new Error(`Plugin ${name}@${version} cache is not registered at the expected version; existing versions are immutable. Close clients and reconcile explicitly or release a new version.`);
  return entry;
}

/** Back up first; restore after each native add and on failure. No trust bypass or model calls. */
export async function updateCodexPlugins({ codexHome = resolveCodexHome(), marketplaceRoot, names, run = nativeRun } = {}) {
  if (!Array.isArray(names) || !names.length) throw new Error('At least one plugin name is required');
  names = [...new Set(names.map(name => valid(name, NAME, 'name')))];
  const market = fs.realpathSync(marketplaceRoot);
  if (!fs.statSync(market).isDirectory()) throw new Error('Marketplace root is not a directory');
  const home = fs.realpathSync(codexHome);
  const temp = owned(home, '.tmp');
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const lock = acquireCacheLock(home);
  let data, previous;
  const updated = [], skipped = [], restored = [];
  try {
    previous = protectedSnapshot(home);
    if (previous) restored.push(...restore(home, previous));
    const previousVersions = new Map(previous?.snapshot.map(({ name, versions }) => [name, new Set(versions)]) ?? []);
    const protectedNames = [...new Set([...(previous?.snapshot.map(item => item.name) ?? []), ...names])];
    const snapshot = protectedNames.map(name => {
      const cache = owned(home, 'plugins', 'cache', 'cc-market', name);
      const live = exists(cache) ? fs.readdirSync(cache).filter(version => VERSION.test(version)) : [];
      const versions = [...new Set([...(previousVersions.get(name) ?? []), ...live])].sort();
      for (const version of versions) if (!previousVersions.get(name)?.has(version))
        validateTree(home, owned(home, 'plugins', 'cache', 'cc-market', name, version));
      return { name, versions };
    });
    const targets = new Map(names.map(name => {
      const native = owned(market, name, '.codex-plugin', 'plugin.json');
      const manifest = JSON.parse(fs.readFileSync(exists(native) ? native : owned(market, name, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (manifest.name !== name) throw new Error('Plugin manifest name does not match selector');
      return [name, valid(manifest.version, VERSION, 'version')];
    }));
    const env = { ...process.env, CODEX_HOME: home };
    const nativeArgs = ['-c', 'marketplaces.cc-market.source_type=local', '-c', `marketplaces.cc-market.source=${JSON.stringify(market)}`];
    const existing = names.filter(name => exists(owned(home, 'plugins', 'cache', 'cc-market', name, targets.get(name))));
    for (const name of existing) requirePayload(market, home, name, targets.get(name));
    // Even read-only native listing can trigger vendor cache GC. Publish protection first.
    const backup = fs.mkdtempSync(path.join(temp, PREFIX));
    for (const { name, versions } of snapshot) for (const version of versions) {
      // Never rebaseline protected survivor bytes: previous immutable snapshots stay canonical.
      const source = previousVersions.get(name)?.has(version) ? owned(previous.backup, name, version) :
        owned(home, 'plugins', 'cache', 'cc-market', name, version);
      const target = owned(backup, name, version);
      fs.mkdirSync(owned(backup, name), { recursive: true });
      fs.cpSync(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true });
    }
    fs.writeFileSync(owned(backup, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    data = { backup, snapshot };
    const pointer = owned(home, '.tmp', POINTER);
    const pending = owned(home, '.tmp', `${POINTER}.${process.pid}.tmp`);
    fs.writeFileSync(pending, backup + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(pending, pointer); }
    finally { if (exists(pending)) fs.unlinkSync(pending); }
    const readRegistrations = async () => {
      try { return await registrations(run, nativeArgs, env); }
      finally { restored.push(...restore(home, data)); }
    };
    const before = await readRegistrations();
    for (const name of existing) requireRegistration(before, name, targets.get(name));
    for (const name of names) {
      const installed = before.find(item => item.pluginId === `${name}@cc-market` && item.installed === true);
      if (installed?.enabled === false && !existing.includes(name))
        throw new Error(`Plugin ${name}@${installed.version} is disabled; native add would enable it. Enable it explicitly before upgrading, or leave it unchanged.`);
    }
    for (const name of names) {
      if (exists(owned(home, 'plugins', 'cache', 'cc-market', name, targets.get(name)))) { skipped.push(name); continue; }
      let result;
      try {
        result = await run('codex', [...nativeArgs, 'plugin', 'add', `${name}@cc-market`, '--json'], { env });
      } finally { restored.push(...restore(home, data)); }
      if (result?.error) throw result.error;
      if (result?.status != null && result.status !== 0) throw new Error(`codex plugin add ${name} failed: ${String(result.stderr ?? '').trim() || result.status}`);
      updated.push(name);
    }
    const after = updated.length ? await readRegistrations() : before;
    for (const name of names) requirePayload(market, home, name, targets.get(name));
    const disabled = names.filter(name => requireRegistration(after, name, targets.get(name)).enabled === false);
    const { conflicts } = inspectProtectedPluginCaches(home);
    return { backup, updated, skipped, restored, ...(disabled.length ? { disabled } : {}), ...(conflicts ? { conflicts } : {}) };
  } finally {
    try {
      try { if (data) restore(home, data); }
      finally { if (previous) restore(home, previous); }
    }
    finally { releaseCacheLock(lock); }
  }
}

if (isMain(import.meta.url)) {
  const [marketplaceRoot, ...names] = process.argv.slice(2);
  const work = marketplaceRoot === '--repair' ? Promise.resolve().then(() => {
    if (names.length) throw new Error('Usage: update-codex-plugins.mjs --repair');
    return repairProtectedPluginCaches();
  }) : updateCodexPlugins({ marketplaceRoot, names });
  work.then(result => {
    console.log(JSON.stringify(result));
    if (result.status === 'busy') process.exitCode = 1;
  }, error => {
    console.error(error.message); process.exitCode = 1;
  });
}
