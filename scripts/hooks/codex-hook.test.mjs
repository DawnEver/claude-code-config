import test from 'node:test';
import assert from 'node:assert/strict';
import { runCodexHook as dispatchCodexHook, codexNotification, boundedRepoReminder } from './codex-hook.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runCodexHook = (input, deps = {}) => dispatchCodexHook(input, { repair: () => {}, ...deps });

test('startup orders synchronization before healing and doctor, never syncs resume/compact', async () => {
  const calls = [];
  const deps = { sync: () => calls.push('sync'), heal: () => { calls.push('heal'); return { warnings: [] }; },
    doctor: () => { calls.push('doctor'); return { systemMessage: 'test warning' }; }, receipt: () => {} };
  assert.match((await runCodexHook({ hook_event_name: 'SessionStart', source: 'startup' }, deps)).systemMessage, /test warning/);
  assert.deepEqual(calls, ['sync', 'heal', 'doctor']);
  calls.length = 0;
  await runCodexHook({ hook_event_name: 'SessionStart', source: 'compact' }, deps);
  assert.deepEqual(calls, []);
});

test('a sync failure remains fail-open but is reported, and later checks still run', async () => {
  let healed = false;
  const out = await runCodexHook({ hook_event_name: 'SessionStart', source: 'startup' }, {
    sync: () => { throw new Error('offline'); }, heal: () => { healed = true; return {}; },
    doctor: () => ({}), receipt: () => {},
  });
  assert.equal(healed, true);
  assert.match(out.systemMessage, /offline/);
});

test('native startup ignores a daemon-lived env marker and shares one checkout lease across homes', async () => {
  const options = [];
  for (const CODEX_HOME of ['/profile/a', '/profile/b']) await runCodexHook({ hook_event_name: 'SessionStart', source: 'startup' }, {
    env: { CODEX_HOME, CC_CONFIG_STARTUP_SYNCED: '1' }, sync: input => options.push(input),
    heal: () => ({}), doctor: () => ({}), receipt: () => {},
  });
  assert.equal(options[0].env.CC_CONFIG_STARTUP_SYNCED, '');
  assert.equal(options[0].stampFile, options[1].stampFile);
});

test('native approval notifications never answer or change approval policy', async () => {
  let notified;
  const out = await runCodexHook({ hook_event_name: 'PermissionRequest', cwd: '/work/project' }, {
    notify: notification => { notified = notification; }, receipt: () => {},
  });
  assert.deepEqual(out, {});
  assert.equal(notified.title, 'Codex — Approval');
});

test('observed native input-request tools notify without answering the question', async () => {
  let notified;
  const out = await runCodexHook({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', cwd: '/work/project' }, {
    guard: () => null, notify: value => { notified = value; }, receipt: () => {},
  });
  assert.deepEqual(out, {});
  assert.equal(notified.title, 'Codex — Input');
});

test('completion uses notify payload, never leaks prompts or last message in notification', () => {
  const out = codexNotification({ type: 'agent-turn-complete', cwd: '/work/project', 'last-assistant-message': 'secret' });
  assert.deepEqual(out, { title: 'Codex — Done', message: 'Task completed in: project', cwd: '/work/project' });
  assert.equal(codexNotification({ type: 'other' }), null);
});

test('SessionEnd uses bounded reminder dependency rather than launching long sync work', async () => {
  let ran = false;
  const out = await runCodexHook({ hook_event_name: 'SessionEnd' }, {
    remind: async () => { ran = true; return 'uncommitted work'; }, receipt: () => {},
  });
  assert.equal(ran, true);
  assert.equal(out.systemMessage, 'uncommitted work');
});

test('shutdown reminder shares one wall-clock budget and runs no network commands', async () => {
  const args = [], limits = [];
  let time = 0;
  const out = await boundedRepoReminder({ now: () => time, budgetMs: 1000, run: (_command, argv, options) => {
    args.push(argv); limits.push(options.timeout); time += 100;
    return argv[0] === 'status' ? ' M config\n' : argv[0] === 'rev-parse' ? 'commit\n' : '2\n';
  } });
  assert.match(out, /unpushed/);
  assert.deepEqual(limits, [1000, 900, 800]);
  assert.ok(args.every(argv => !argv.includes('fetch') && !argv.includes('push')));
});

function protectedHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-repair-'))); // macOS tmpdir is a symlink; the code compares real paths
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const backup = path.join(home, '.tmp', 'cc-config-plugin-backup-fixture');
  fs.mkdirSync(path.join(backup, 'rem', '1.0.0'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'rem', '1.0.0', 'entry.mjs'), 'protected runtime');
  fs.writeFileSync(path.join(backup, 'snapshot.json'), JSON.stringify([{ name: 'rem', versions: ['1.0.0'] }]));
  fs.writeFileSync(path.join(home, '.tmp', 'cc-config-plugin-backup-pointer'), backup);
  return { home, entry: path.join(home, 'plugins', 'cache', 'cc-market', 'rem', '1.0.0', 'entry.mjs') };
}

test('startup repairs after healing before doctor and PreToolUse repairs before guard', async t => {
  const f = protectedHome(t), calls = [];
  await dispatchCodexHook({ hook_event_name: 'SessionStart', source: 'startup' }, {
    env: { CODEX_HOME: f.home }, sync: () => {}, receipt: () => {},
    heal: () => { calls.push('heal'); assert.equal(fs.existsSync(f.entry), false); },
    doctor: () => { calls.push('doctor'); assert.equal(fs.readFileSync(f.entry, 'utf8'), 'protected runtime'); },
  });
  assert.deepEqual(calls, ['heal', 'doctor']);
  fs.unlinkSync(f.entry);
  await dispatchCodexHook({ hook_event_name: 'PreToolUse', tool_name: 'write_stdin' }, {
    env: { CODEX_HOME: f.home }, receipt: () => {},
    guard: () => assert.equal(fs.readFileSync(f.entry, 'utf8'), 'protected runtime'),
  });
});

test('cache repair errors fail open and never prevent the guard', async () => {
  let guarded = false;
  const out = await runCodexHook({ hook_event_name: 'PreToolUse' }, {
    receipt: () => {}, repair: () => { throw new Error('invalid protected cache pointer'); },
    guard: () => { guarded = true; },
  });
  assert.equal(guarded, true);
  assert.match(out.systemMessage, /invalid protected cache pointer/);
});

test('deferred cache repair does not block the native tool guard', async () => {
  let guarded = false;
  const out = await runCodexHook({ hook_event_name: 'PreToolUse' }, {
    receipt: () => {}, repair: options => { assert.equal(options.quick, true); return { status: 'deferred', restored: [] }; },
    guard: () => { guarded = true; },
  });
  assert.equal(guarded, true);
  assert.match(out.systemMessage, /deferred/i);
});

test('real native entry restores a protected runtime file without vendor calls', t => {
  const f = protectedHome(t);
  const script = fileURLToPath(new URL('./codex-hook.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--event', 'PreToolUse'], {
    env: { ...process.env, CODEX_HOME: f.home }, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'write_stdin', thread_id: 'repair-fixture' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.entry, 'utf8'), 'protected runtime');
});

test('PreToolUse revives a dead bridge daemon before the guard, failing open', async () => {
  const calls = [];
  const out = await runCodexHook({ hook_event_name: 'PreToolUse' }, {
    receipt: () => {}, repair: () => null,
    revive: () => { calls.push('revive'); throw new Error('spawn failed'); }, guard: () => { calls.push('guard'); },
  });
  assert.deepEqual(calls, ['revive', 'guard']);
  assert.match(out.systemMessage, /spawn failed/);
});
