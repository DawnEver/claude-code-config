import test from 'node:test';
import assert from 'node:assert/strict';
import { runCodexHook, codexNotification, boundedRepoReminder } from './codex-hook.mjs';

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
