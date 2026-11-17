import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { STEPS, stepsFor, runStep, runSteps, mergeOutputs, failureOf, startBackgroundLane, hookCommand, wallBudgetMs } from './claude-hook.mjs';
import { mirrorFor, callHub } from './bridge-hook.js';
import { ClaudeAdapter } from '../bridge/claude-adapter.mjs';
import { checkHooks } from '../setup/doctor.js';
import { hooksDrift } from '../setup/settings-hooks.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPTS = path.join(REPO, 'scripts');
const template = JSON.parse(fs.readFileSync(path.join(REPO, 'claude_settings.template.json'), 'utf8'));
const IS_MAIN = pathToFileURL(path.join(SCRIPTS, 'shared', 'is-main.mjs')).href;

/** Claude Code's matcher: absent or `*` matches all; a plain `A|B` list matches those names exactly. */
const matches = (matcher, name) => !matcher || matcher === '*' || (/^[\w|]+$/.test(matcher)
  ? matcher.split('|').includes(name) : new RegExp(matcher).test(name));

/**
 * The node processes Claude Code starts for one hook event: one per distinct matching command
 * (a bootstrap command's normal path is its one `exec node`).
 */
function nodeProcesses(settings, event, name = '') {
  const commands = new Set((settings.hooks?.[event] ?? []).filter((g) => matches(g.matcher, name))
    .flatMap((g) => g.hooks).map((h) => h.command).filter((c) => /(?:^|\s)node\s/.test(c)));
  return commands.size;
}

/** Node processes for one tool call: its PreToolUse plus its PostToolUse (or PostToolUseFailure). */
const perToolCall = (settings, tool, failed = false) =>
  nodeProcesses(settings, 'PreToolUse', tool) + nodeProcesses(settings, failed ? 'PostToolUseFailure' : 'PostToolUse', tool);

const BRIDGE = 'node ~/.claude/scripts/hooks/bridge-hook.js';
const GUARD = 'node ~/.claude/scripts/hooks/loop-guard-hook.js';
// Two retired wirings, kept as planted controls: the original (three processes per tool call, a
// faithful mirror) and the narrowed one (one process, but a mirror that lost foreground shells and
// kept a terminal-approved prompt at waiting-approval).
const ORIGINAL_TOOL_HOOKS = { hooks: {
  PreToolUse: [{ matcher: '*', hooks: [{ command: GUARD }] }, { matcher: 'AskUserQuestion', hooks: [{ command: `${BRIDGE} --question` }] },
    { matcher: '*', hooks: [{ command: BRIDGE }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ command: BRIDGE }] }],
  PostToolUseFailure: [{ matcher: 'Bash|Agent|Task', hooks: [{ command: BRIDGE }] }],
} };
const NARROWED_TOOL_HOOKS = { hooks: {
  PreToolUse: [{ matcher: '*', hooks: [{ command: GUARD }] }, { matcher: 'AskUserQuestion', hooks: [{ command: `${BRIDGE} --question` }] },
    { matcher: 'Agent|Task|Monitor', hooks: [{ command: BRIDGE }] }],
  PostToolUse: [{ matcher: 'AskUserQuestion|Agent|Task|TaskStop', hooks: [{ command: BRIDGE }] }],
  PostToolUseFailure: [{ matcher: 'Agent|Task|Monitor', hooks: [{ command: BRIDGE }] }],
  Notification: template.hooks.Notification,
} };

/**
 * Whether `settings` makes the bridge's mirror call (not its question call) for one hook payload:
 * a matching direct bridge-hook command, or a claude-hook entry whose steps include it.
 */
function bridgeMirrors(settings, payload) {
  const event = payload.hook_event_name;
  const name = event === 'Notification' ? payload.notification_type : payload.tool_name;
  return (settings.hooks?.[event] ?? []).filter((g) => matches(g.matcher, name)).flatMap((g) => g.hooks).some((h) => {
    if (/bridge-hook\.js$/.test(h.command)) return true;
    const entry = /claude-hook\.mjs --event (\w+)$/.exec(h.command);
    return Boolean(entry) && stepsFor(entry[1], 'foreground', payload).some((s) => s.script === 'hooks/bridge-hook.js' && !s.args?.includes('--question'));
  });
}

test('SessionStart keeps its scripts in order, each in its lane, the foreground ones within the 5 s event budget', () => {
  assert.deepEqual(STEPS.SessionStart.map((s) => [s.script, (s.args ?? []).join(' '), s.budgetMs, Boolean(s.background), Boolean(s.concurrent)]), [
    ['hooks/sync-hook.js', '--pull-background', 1000, false, false],
    ['hooks/prune-cache-hook.js', '', 10000, true, false],
    ['hooks/setup-check-hook.js', '', 2000, false, false],
    ['setup/doctor.js', '--hook', 1500, false, false],
    ['bridge/ensure.mjs', '', 10000, true, false],
    ['hooks/bridge-hook.js', '--learn', 3500, false, true],
  ]);
  assert.deepEqual(stepsFor('SessionStart', 'foreground', { source: 'startup' }).map((s) => s.args?.[0]), ['--pull-background', undefined, '--hook'],
    'a startup keeps its id: no process lookup');
  assert.ok(stepsFor('SessionStart', 'foreground', { source: 'clear' }).some((s) => s.args?.includes('--learn')), '/clear renames: its process is learned');
});

// User ruling D24 (2026-11-17): every hook < 5 s, strictly, and the 5 s are for the whole EVENT.
// The timeout is the backstop: Claude Code treats a hook it kills at its timeout as a non-blocking
// error (the call or prompt proceeds), so a guard killed there allows the call. Each hook is fast
// on its own, or hands its slow part to a detached process.
const MAX_HOOK_TIMEOUT_S = 5;
/** Every hook of a settings object whose timeout is missing or above the ceiling. */
function timeoutViolations(settings) {
  return Object.entries(settings?.hooks ?? {}).flatMap(([event, groups]) => (groups ?? []).flatMap((g) => g.hooks ?? [])
    .filter((h) => !(typeof h.timeout === 'number' && h.timeout > 0 && h.timeout <= MAX_HOOK_TIMEOUT_S))
    .map((h) => `${event}: timeout ${h.timeout ?? 'missing'} (${String(h.command).slice(-60)})`));
}

test('every templated hook has a timeout of at most 5 s', () => {
  const one = (timeout) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js', ...(timeout === undefined ? {} : { timeout }) }] }] } });
  assert.equal(timeoutViolations(one(15)).length, 1, 'PLANTED CONTROL: a 15 s timeout fails');
  assert.equal(timeoutViolations(one(undefined)).length, 1, 'PLANTED CONTROL: a missing timeout (the 60 s default) fails');
  assert.deepEqual(timeoutViolations(one(5)), []);
  assert.ok(Object.keys(template.hooks).length >= 9, 'the scan sees the templated events');
  assert.deepEqual(timeoutViolations(template), []);
});

test('every event runs its foreground steps within the 5 s event budget', () => {
  assert.equal(wallBudgetMs([{ budgetMs: 1000 }, { budgetMs: 1500 }, { budgetMs: 2000, concurrent: true }]), 2500, 'ordered steps add up');
  assert.equal(wallBudgetMs([{ budgetMs: 1000 }, { budgetMs: 3500, concurrent: true }]), 3500, 'a concurrent step runs beside them');
  assert.ok(wallBudgetMs([{ budgetMs: 660000 }]) > 4500, 'PLANTED CONTROL: the old ten-minute question step breaks the budget');
  const payloads = [{ notification_type: 'permission_prompt' }, { tool_name: 'AskUserQuestion' }, { tool_name: 'Bash' }, { source: 'startup' }, { source: 'clear' }];
  for (const event of Object.keys(STEPS)) {
    const total = Math.max(...payloads.map((p) => wallBudgetMs(stepsFor(event, 'foreground', p))));
    assert.ok(total <= 4500, `${event}: ${total} ms of foreground step budgets`);
  }
});

test('every step script exists', () => {
  for (const s of Object.values(STEPS).flat()) assert.ok(fs.existsSync(path.join(SCRIPTS, s.script)), s.script);
});

test('the template runs SessionStart, Notification and PreToolUse through ONE entry each, timed to cover its steps', () => {
  const payloads = [{ notification_type: 'permission_prompt' }, { tool_name: 'AskUserQuestion' }, { tool_name: 'Bash' }];
  for (const event of ['SessionStart', 'Notification', 'PreToolUse']) {
    const hooks = template.hooks[event].flatMap((g) => g.hooks);
    assert.equal(hooks.length, 1, `${event}: one entry`);
    assert.equal(template.hooks[event].every((g) => !g.matcher || g.matcher === '*'), true, `${event}: the steps filter, not the entry`);
    assert.equal(hooks[0].command, hookCommand(event), `${event}: the template carries hookCommand verbatim`);
    const foreground = Math.max(...payloads.map((p) => wallBudgetMs(stepsFor(event, 'foreground', p))));
    assert.ok(hooks[0].timeout * 1000 > foreground, `${event}: timeout ${hooks[0].timeout}s covers ${foreground} ms of steps`);
  }
  assert.equal(template.hooks.Notification[0].hooks[0].async, true, 'both Notification handlers were async');
  assert.notEqual(template.hooks.SessionStart[0].hooks[0].async, true, 'its systemMessage must reach the session');
  assert.notEqual(template.hooks.PreToolUse[0].hooks[0].async, true, 'a deny and a question answer must reach the call');
});

test('the bridge mirrors every event it did before the consolidation', () => {
  const direct = Object.entries(template.hooks).flatMap(([event, groups]) => groups
    .filter((g) => g.hooks.some((h) => /bridge-hook\.js/.test(h.command))).map((g) => `${event}(${g.matcher ?? ''})`));
  assert.deepEqual(direct.sort(), ['PostToolUse(*)', 'PostToolUseFailure(*)', 'Stop()', 'StopFailure()', 'UserPromptSubmit()']);
  assert.deepEqual(stepsFor('Notification', 'foreground', { notification_type: 'idle_prompt' }).map((s) => s.script),
    ['hooks/notify-hook.js', 'hooks/bridge-hook.js']);
  const pre = (tool) => stepsFor('PreToolUse', 'foreground', { tool_name: tool }).map((s) => [s.script, ...(s.args ?? [])].join(' '));
  assert.deepEqual(pre('Bash'), ['hooks/loop-guard-hook.js', 'hooks/bridge-hook.js']);
  assert.deepEqual(pre('AskUserQuestion'), ['hooks/loop-guard-hook.js', 'hooks/bridge-hook.js --question'], 'its question call, not a second mirror');
  for (const tool of ['Read', 'Edit', 'Bash', 'PowerShell', 'Agent', 'Monitor', 'TaskStop', 'AskUserQuestion', 'mcp__x__y']) {
    for (const event of ['PostToolUse', 'PostToolUseFailure']) assert.equal(bridgeMirrors(template, { hook_event_name: event, tool_name: tool }), true, `${event}(${tool})`);
    if (tool !== 'AskUserQuestion') assert.equal(bridgeMirrors(template, { hook_event_name: 'PreToolUse', tool_name: tool }), true, `PreToolUse(${tool})`);
  }
});

test('node processes per tool call: two (pre + post), down from three', () => {
  for (const tool of ['Read', 'Edit', 'Grep', 'Bash', 'PowerShell', 'Write', 'Agent', 'Monitor', 'TaskStop', 'AskUserQuestion']) {
    assert.equal(perToolCall(template, tool), 2, tool);
    assert.equal(perToolCall(template, tool, true), 2, `${tool} failed`);
  }
  for (const tool of ['Read', 'Edit', 'Bash']) assert.equal(perToolCall(ORIGINAL_TOOL_HOOKS, tool), 3, `${tool} under the original wiring`);
  assert.equal(perToolCall(ORIGINAL_TOOL_HOOKS, 'AskUserQuestion'), 4);
  assert.equal(nodeProcesses(template, 'SessionStart'), 1);
  assert.equal(nodeProcesses(template, 'Notification'), 1);
});

test('stepsFor: lanes split by background, a match filters on its payload field', () => {
  assert.deepEqual(stepsFor('SessionStart', 'background').map((s) => s.script), ['hooks/prune-cache-hook.js', 'bridge/ensure.mjs']);
  assert.deepEqual(stepsFor('SessionStart', 'foreground').map((s) => s.script), ['hooks/sync-hook.js', 'hooks/setup-check-hook.js', 'setup/doctor.js']);
  assert.deepEqual(stepsFor('Notification', 'foreground', { notification_type: 'auth_success' }).map((s) => s.script), ['hooks/notify-hook.js']);
  assert.deepEqual(stepsFor('Notification', 'foreground', { notification_type: 'permission_prompt_x' }).map((s) => s.script), ['hooks/notify-hook.js'], 'anchored');
  assert.equal(stepsFor('PreToolUse', 'foreground', { tool_name: 'AskUserQuestionX' }).at(-1).args, undefined, 'the exclusion is anchored too');
  assert.deepEqual(stepsFor('Nope', 'foreground'), []);
});

// ── the mirror: what the wired hooks tell the bridge's state machine ──

/** A live hub with one registered channel session 's', and a send that delivers what `settings` mirrors. */
async function hub(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-hub-'));
  const a = new ClaudeAdapter();
  const port = await a.listen(0);
  const runtimeFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ port, token: a.token }));
  const ch = await new Promise((r) => { const s = net.connect({ host: '127.0.0.1', port }); s.setEncoding('utf8'); s.once('connect', () => r(s)); });
  await new Promise((r) => { ch.once('data', r); ch.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'register', params: { token: a.token, sessionId: 's' } }) + '\n'); });
  const send = async (payload, at) => {
    if (!bridgeMirrors(settings, payload)) return false;
    await callHub('mirror', { ...mirrorFor({ session_id: 's', ...payload }), at }, { runtimeFile });
    return true;
  };
  const close = async () => { ch.destroy(); await a.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { a, send, close, snap: () => a.statusSnapshot('s') };
}

test('mirror: a permission approved in the terminal leaves waiting-approval at its PostToolUse; the narrowed wiring stayed (planted control)', async () => {
  for (const [settings, expected] of [[template, 'running'], [NARROWED_TOOL_HOOKS, 'waiting-approval']]) {
    const h = await hub(settings);
    try {
      await h.send({ hook_event_name: 'UserPromptSubmit', prompt: 'edit it' }, 100);
      assert.equal(await h.send({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Edit' }, 200), true);
      assert.equal(h.snap().state, 'waiting-approval');
      await h.send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'u1', tool_input: {}, tool_response: {} }, 300);
      assert.equal(h.snap().state, expected, settings === template ? 'the template' : 'the narrowed wiring');
    } finally { await h.close(); }
  }
});

test('mirror: a foreground Bash call reaches the board at its PreToolUse and leaves it at its PostToolUse', async () => {
  const bash = { tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'npm test', description: 'Run the tests' } };
  for (const [settings, expected] of [[template, [['u1', 'shell', 'Run the tests']]], [NARROWED_TOOL_HOOKS, undefined]]) {
    const h = await hub(settings);
    try {
      await h.send({ hook_event_name: 'UserPromptSubmit', prompt: 'test it' }, 100);
      await h.send({ hook_event_name: 'PreToolUse', ...bash }, 200);
      assert.deepEqual(h.snap().tasks?.map((t) => [t.id, t.kind, t.label]), expected, settings === template ? 'the template' : 'the narrowed wiring');
      await h.send({ hook_event_name: 'PostToolUse', ...bash, tool_response: { stdout: 'ok' } }, 300);
      if (settings === template) assert.equal(h.snap().tasks, undefined, 'ended: the board lists only running tasks');
    } finally { await h.close(); }
  }
});

// ── the entry's steps ──

/** A scripts dir holding `files` ({relative path: source}). */
function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-'));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  return dir;
}

test('runStep: the script gets its own argv, its entry guard fires, and the payload arrives on its stdin', async () => {
  const dir = fixtureDir({ 'hooks/echo.mjs': `import { isMain } from '${IS_MAIN}';
    if (isMain(import.meta.url)) { let raw = ''; for await (const c of process.stdin) raw += c;
      process.stdout.write(JSON.stringify({ systemMessage: process.argv.slice(2).join(' ') + ' ' + JSON.parse(raw).source })); }` });
  try {
    const r = await runStep({ script: 'hooks/echo.mjs', args: ['--a', 'b'], budgetMs: 5000 }, '{"source":"startup"}', { scriptsDir: dir });
    assert.deepEqual([r.code, r.timedOut, r.error, JSON.parse(r.out)], [0, false, null, { systemMessage: '--a b startup' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSteps: a throw, an exit code and an overrun each end only their step; the rest run and failures are named', async () => {
  const dir = fixtureDir({
    'a.mjs': `process.stdout.write(JSON.stringify({ systemMessage: 'first', ccConfigSync: { pulled: 1 } }));`,
    'throws.mjs': `throw new Error('boom');`,
    'exits.mjs': `process.stdout.write('{"systemMessage":"said before exit"}'); process.exit(3);`,
    'spins.mjs': `const t = Date.now(); while (Date.now() - t < 20000) {}`,
    'z.mjs': `process.stdout.write(JSON.stringify({ systemMessage: 'last', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } }));`,
  });
  const steps = ['a.mjs', 'throws.mjs', 'exits.mjs', 'spins.mjs', 'z.mjs'].map((script) => ({ script, budgetMs: script === 'spins.mjs' ? 500 : 5000 }));
  const t0 = Date.now();
  try {
    const { output: out, blocked } = await runSteps(steps, '{}', 'SessionStart', { run: (s, raw) => runStep(s, raw, { scriptsDir: dir }) });
    assert.ok(Date.now() - t0 < 4000, 'no step waits on its budget but the spinning one, terminated at 0.5 s');
    assert.equal(blocked, null);
    assert.deepEqual(out.ccConfigSync, { pulled: 1 });
    assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: 'ctx' });
    const lines = out.systemMessage.split('\n');
    assert.equal(lines[0], 'first');
    assert.match(lines[1], /^\[claude-hook\] SessionStart: throws\.mjs failed: boom$/);
    assert.deepEqual(lines.slice(2), ['said before exit', '[claude-hook] SessionStart: exits.mjs exited 3',
      '[claude-hook] SessionStart: spins.mjs timed out after 0.5s', 'last']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runSteps: a deny is the entry\'s and ends the run; an exit 2 is the entry\'s block', async () => {
  const log = path.join(os.tmpdir(), `claude-hook-after-${process.pid}.txt`);
  const dir = fixtureDir({
    'warns.mjs': `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'careful' } }));`,
    'denies.mjs': `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'looping' } })); process.exit(0);`,
    'blocks.mjs': `process.stderr.write('blocked: reason\\n'); process.exit(2);`,
    'after.mjs': `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(log)}, 'ran');`,
    'allows.mjs': `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { answers: { q: 'a' } } } }));`,
  });
  const run = (s, raw) => runStep(s, raw, { scriptsDir: dir });
  const steps = (...names) => names.map((script) => ({ script, budgetMs: 5000 }));
  try {
    const denied = await runSteps(steps('warns.mjs', 'denies.mjs', 'after.mjs'), '{}', 'PreToolUse', { run });
    assert.deepEqual(denied, { blocked: null, output: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'careful', permissionDecision: 'deny', permissionDecisionReason: 'looping' } } });
    assert.equal(fs.existsSync(log), false, 'nothing runs for a denied call');
    assert.deepEqual(await runSteps(steps('blocks.mjs', 'after.mjs'), '{}', 'PreToolUse', { run }), { output: {}, blocked: 'blocked: reason\n' });
    assert.equal(fs.existsSync(log), false);
    const allowed = await runSteps(steps('allows.mjs', 'after.mjs'), '{}', 'PreToolUse', { run });
    assert.deepEqual(allowed.output.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { answers: { q: 'a' } } }, 'a question answer reaches the call');
    assert.equal(fs.readFileSync(log, 'utf8'), 'ran', 'planted control: an allowed call runs the rest');
    fs.rmSync(log);
    const beside = await runSteps([...steps('denies.mjs'), { script: 'after.mjs', budgetMs: 5000, concurrent: true }], '{}', 'PreToolUse', { run });
    assert.equal(beside.output.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(fs.readFileSync(log, 'utf8'), 'ran', 'a concurrent step started beside the denying one, as its own async entry did');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(log, { force: true }); }
});

test('the real loop guard denies through the shared entry; the bridge activity runs beside it, as before', async () => {
  const env = { HARNESS_LOOP_GUARD_WARN_AT: '2', HARNESS_LOOP_GUARD_DENY_AT: '3', HARNESS_LOOP_GUARD_DISABLE: '0', HARNESS_AGENT: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const raw = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: `claude-hook-test-${process.pid}-${Date.now()}`, tool_name: 'Bash', tool_input: { command: 'echo same' } });
  const steps = stepsFor('PreToolUse', 'foreground', JSON.parse(raw));
  const ran = [];
  // The bridge step is stubbed: a live daemon on this machine must not receive a test session.
  const run = (s, r) => { ran.push(s.script); return s.script === 'hooks/bridge-hook.js' ? Promise.resolve({ out: '', err: '', code: 0, timedOut: false, error: null }) : runStep(s, r); };
  try {
    const decisions = [];
    for (let i = 0; i < 3; i++) {
      ran.length = 0;
      const { output } = await runSteps(steps, raw, 'PreToolUse', { run });
      decisions.push(output.hookSpecificOutput?.permissionDecision ?? (output.hookSpecificOutput?.additionalContext ? 'warn' : 'ok'));
    }
    assert.deepEqual(decisions, ['ok', 'warn', 'deny']);
    assert.deepEqual(ran.sort(), ['hooks/bridge-hook.js', 'hooks/loop-guard-hook.js']);
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('a missing step script is a named failure, not a silent no-op', async () => {
  const r = await runStep({ script: 'hooks/absent.mjs', budgetMs: 5000 }, '{}', { scriptsDir: os.tmpdir() });
  assert.match(failureOf({ script: 'hooks/absent.mjs', budgetMs: 5000 }, r), /^hooks\/absent\.mjs (failed|exited)/);
});

test('mergeOutputs: silent steps add nothing; plain text is shown, never injected as context; the strictest decision wins', () => {
  assert.deepEqual(mergeOutputs([{ step: { script: 'a' }, out: '' }, { step: { script: 'b' }, out: '  ' }], 'SessionStart'), {});
  assert.deepEqual(mergeOutputs([{ step: { script: 'x.js' }, out: 'hello' }], 'SessionStart'), { systemMessage: '[x.js] hello' });
  const decide = (d, r) => ({ step: { script: d }, out: JSON.stringify({ hookSpecificOutput: { permissionDecision: d, permissionDecisionReason: r } }) });
  assert.deepEqual(mergeOutputs([decide('allow', 'a'), decide('ask', 'b'), decide('allow', 'c')], 'PreToolUse').hookSpecificOutput,
    { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'b' });
});

test('startBackgroundLane: one detached copy of the entry, the payload on its stdin', () => {
  const calls = [];
  let written = null;
  const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end: (d) => { written = d; } }), unref: () => calls.push('unref') });
  startBackgroundLane('SessionStart', '{"source":"startup"}', { run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; } });
  assert.equal(calls[0].cmd, process.execPath);
  assert.match(calls[0].args[0], /claude-hook\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ['--event', 'SessionStart', '--lane', 'background']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(written, '{"source":"startup"}');
  assert.equal(calls[1], 'unref');
});

// ── the bootstrap: the synced settings reach a workstation before its checkout has the entry ──

/** A POSIX sh: on PATH, else the one Git for Windows ships beside git. */
function findSh() {
  if (!spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).error) return 'sh';
  const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
  return path.resolve(exec, '..', '..', '..', 'usr', 'bin', 'sh.exe');
}
const SH = findSh();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, windowsHide: true, stdio: 'pipe' });

// A fake entry and a fake pull, each logging that it ran; the pull may bring the entry with it.
const FAKE_ENTRY = "import fs from 'node:fs'; let raw = ''; for await (const c of process.stdin) raw += c;" +
  " fs.appendFileSync(process.env.LOG, 'entry ' + process.argv.slice(2).join(' ') + ' ' + raw + '\\n');";
const fakePull = (brings) => "import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';" +
  " fs.appendFileSync(process.env.LOG, 'pull ' + process.argv.slice(2).join(' ') + '\\n');" +
  (brings ? ` fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-hook.mjs'), ${JSON.stringify(FAKE_ENTRY)});` : '');

/** A HOME whose ~/.claude is a git checkout holding scripts/hooks: the pull, and the entry when `entry`. */
function home({ entry = false, brings = false, upstreamCarries = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-boot-'));
  const repo = path.join(dir, '.claude'), hooks = path.join(repo, 'scripts', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(hooks, 'sync-hook.js'), fakePull(brings));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'old checkout');
  if (upstreamCarries) {   // the upstream has the entry; this checkout did not fast-forward to it
    git(repo, 'checkout', '-qb', 'up'); fs.writeFileSync(path.join(hooks, 'claude-hook.mjs'), FAKE_ENTRY);
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'entry'); git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '--set-upstream-to=up');
  }
  if (entry) fs.writeFileSync(path.join(hooks, 'claude-hook.mjs'), FAKE_ENTRY);
  return { dir, log: path.join(dir, 'log.txt') };
}

function runCommand(event, h) {
  const r = spawnSync(SH, ['-c', hookCommand(event)], { input: '{"source":"startup"}', encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: h.dir.replace(/\\/g, '/'), LOG: h.log, CC_CONFIG_STARTUP_SYNCED: '' } });
  const log = fs.existsSync(h.log) ? fs.readFileSync(h.log, 'utf8').trim().split('\n') : [];
  return { status: r.status, out: r.stdout.trim(), log };
}

const rm = (...hs) => { for (const h of hs) fs.rmSync(h.dir, { recursive: true, force: true }); };
const SKIPPED = '[claude-hook] SessionStart hooks skipped: claude-hook.mjs is absent and ';
const DOOR = '. Launch via ccc, or run: node ~/.claude/scripts/hooks/sync-hook.js --pull';

test('bootstrap: with the entry present no pull runs, and the entry gets the payload', () => {
  const h = home({ entry: true });
  try {
    assert.deepEqual(runCommand('SessionStart', h), { status: 0, out: '', log: ['entry --event SessionStart {"source":"startup"}'] });
    assert.equal(runCommand('Notification', h).log.at(-1), 'entry --event Notification {"source":"startup"}');
    assert.equal(runCommand('PreToolUse', h).log.at(-1), 'entry --event PreToolUse {"source":"startup"}');
  } finally { rm(h); }
});

test('bootstrap: with the entry absent, SessionStart runs the old pull, then the entry it brought (planted control)', () => {
  const h = home({ brings: true });
  try {
    assert.deepEqual(runCommand('SessionStart', h), { status: 0, out: '', log: ['pull --pull', 'entry --event SessionStart {"source":"startup"}'] });
  } finally { rm(h); }
});

test('bootstrap: still absent after the pull, SessionStart exits 0 naming the cause and the door', () => {
  const notCarried = home(), notFastForwarded = home({ upstreamCarries: true });
  try {
    const a = runCommand('SessionStart', notCarried);
    assert.deepEqual([a.status, a.log], [0, ['pull --pull']]);
    assert.deepEqual(JSON.parse(a.out), { systemMessage: `${SKIPPED}its upstream does not carry it yet (offline, or main not yet promoted)${DOOR}` });
    const b = runCommand('SessionStart', notFastForwarded);
    assert.deepEqual([b.status, b.log], [0, ['pull --pull']]);
    assert.deepEqual(JSON.parse(b.out), { systemMessage: `${SKIPPED}the pull did not fast-forward this checkout${DOOR}` });
  } finally { rm(notCarried, notFastForwarded); }
});

test('bootstrap: Notification and PreToolUse without the entry exit 0 silently and pull nothing: a tool call is never blocked', () => {
  const h = home();
  try {
    assert.deepEqual(runCommand('Notification', h), { status: 0, out: '', log: [] });
    assert.deepEqual(runCommand('PreToolUse', h), { status: 0, out: '', log: [] });
  } finally { rm(h); }
});

test('doctor reads the entry out of the bootstrap command; the drift check holds on it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-doc-'));
  const events = ['SessionStart', 'Notification', 'PreToolUse'];
  const settings = { hooks: Object.fromEntries(events.map((e) => [e, template.hooks[e]])) };
  try {
    const missing = checkHooks(settings, dir);
    assert.deepEqual(missing.map((f) => f.id), events.map(() => 'hook-missing'), 'planted: no entry in this home');
    assert.match(missing[0].title, /claude-hook\.mjs/);
    fs.mkdirSync(path.join(dir, '.claude', 'scripts', 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS, 'hooks', 'claude-hook.mjs'), path.join(dir, '.claude', 'scripts', 'hooks', 'claude-hook.mjs'));
    assert.deepEqual(checkHooks(settings, dir), []);
    assert.deepEqual(hooksDrift(structuredClone(template), template), []);
    assert.deepEqual(hooksDrift({ hooks: { ...template.hooks, ...NARROWED_TOOL_HOOKS.hooks } }, template), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
