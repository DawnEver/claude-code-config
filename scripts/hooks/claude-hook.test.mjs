import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STEPS, stepsFor, runStep, runSteps, mergeOutputs, failureOf, startBackgroundLane } from './claude-hook.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPTS = path.join(REPO, 'scripts');
const template = JSON.parse(fs.readFileSync(path.join(REPO, 'claude_settings.template.json'), 'utf8'));
const IS_MAIN = pathToFileURL(path.join(SCRIPTS, 'shared', 'is-main.mjs')).href;

/** Claude Code's matcher: absent or `*` matches all; a plain `A|B` list matches those names exactly. */
const matches = (matcher, name) => !matcher || matcher === '*' || (/^[\w|]+$/.test(matcher)
  ? matcher.split('|').includes(name) : new RegExp(matcher).test(name));

/** The node processes Claude Code starts for one hook event: one per distinct matching command. */
function nodeProcesses(settings, event, name = '') {
  const commands = new Set((settings.hooks?.[event] ?? []).filter((g) => matches(g.matcher, name))
    .flatMap((g) => g.hooks).map((h) => h.command).filter((c) => /^node\s/.test(c)));
  return commands.size;
}

/** Node processes for one tool call: its PreToolUse plus its PostToolUse (or PostToolUseFailure). */
const perToolCall = (settings, tool, failed = false) =>
  nodeProcesses(settings, 'PreToolUse', tool) + nodeProcesses(settings, failed ? 'PostToolUseFailure' : 'PostToolUse', tool);

const OLD_TOOL_HOOKS = { hooks: {   // the wiring this change retired, kept as the planted control below
  PreToolUse: [{ matcher: '*', hooks: [{ command: 'node ~/.claude/scripts/hooks/loop-guard-hook.js' }] },
    { matcher: 'AskUserQuestion', hooks: [{ command: 'node ~/.claude/scripts/hooks/bridge-hook.js --question' }] },
    { matcher: '*', hooks: [{ command: 'node ~/.claude/scripts/hooks/bridge-hook.js' }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ command: 'node ~/.claude/scripts/hooks/bridge-hook.js' }] }],
} };

test('SessionStart keeps its five scripts in order, each with the budget and lane its own entry had', () => {
  assert.deepEqual(STEPS.SessionStart.map((s) => [s.script, (s.args ?? []).join(' '), s.budgetMs, Boolean(s.background)]), [
    ['hooks/sync-hook.js', '--pull-background', 10000, false],
    ['hooks/prune-cache-hook.js', '', 10000, true],
    ['hooks/setup-check-hook.js', '', 5000, false],
    ['setup/doctor.js', '--hook', 10000, false],
    ['bridge/ensure.mjs', '', 10000, true],
  ]);
});

test('every step script exists', () => {
  for (const s of Object.values(STEPS).flat()) assert.ok(fs.existsSync(path.join(SCRIPTS, s.script)), s.script);
});

test('the template runs SessionStart and Notification through ONE entry each, timed to cover its steps', () => {
  for (const event of ['SessionStart', 'Notification']) {
    const hooks = template.hooks[event].flatMap((g) => g.hooks);
    assert.equal(hooks.length, 1, `${event}: one entry`);
    assert.equal(template.hooks[event].every((g) => !g.matcher), true, `${event}: the steps filter, not the entry`);
    assert.equal(hooks[0].command, `node ~/.claude/scripts/hooks/claude-hook.mjs --event ${event}`);
    const foreground = stepsFor(event, 'foreground', { notification_type: 'permission_prompt' }).reduce((t, s) => t + s.budgetMs, 0);
    assert.ok(hooks[0].timeout * 1000 > foreground, `${event}: timeout ${hooks[0].timeout}s covers ${foreground} ms of steps`);
  }
  assert.equal(template.hooks.Notification[0].hooks[0].async, true, 'both Notification handlers were async');
  assert.notEqual(template.hooks.SessionStart[0].hooks[0].async, true, 'its systemMessage must reach the session');
});

test('the bridge is wired only for what the session mirror needs', () => {
  const bridged = Object.entries(template.hooks).flatMap(([event, groups]) => groups
    .filter((g) => g.hooks.some((h) => /bridge-hook\.js/.test(h.command)))
    .map((g) => `${event}(${g.matcher ?? ''})${g.hooks.find((h) => /bridge-hook\.js/.test(h.command)).command.includes('--question') ? ' --question' : ''}`));
  assert.deepEqual(bridged.sort(), [
    'PostToolUse(AskUserQuestion|Agent|Task|TaskStop)',
    'PostToolUseFailure(Agent|Task|Monitor)',
    'PreToolUse(Agent|Task|Monitor)',
    'PreToolUse(AskUserQuestion) --question',
    'Stop()',
    'StopFailure()',
    'UserPromptSubmit()',
  ]);
  assert.deepEqual(stepsFor('Notification', 'foreground', { notification_type: 'idle_prompt' }).map((s) => s.script),
    ['hooks/notify-hook.js', 'hooks/bridge-hook.js']);
});

test('node processes per tool call: one for an ordinary tool, the retired wiring paid three (planted control)', () => {
  for (const tool of ['Read', 'Edit', 'Grep', 'Bash', 'PowerShell', 'Write']) {
    assert.equal(perToolCall(template, tool), 1, tool);
    assert.equal(perToolCall(OLD_TOOL_HOOKS, tool), 3, `${tool} under the retired wiring`);
  }
  assert.equal(perToolCall(template, 'Bash', true), 1, 'a failed shell');
  assert.equal(perToolCall(template, 'Agent'), 3, 'an agent call is a task on the activity board');
  assert.equal(nodeProcesses(template, 'SessionStart'), 1);
  assert.equal(nodeProcesses(template, 'Notification'), 1);
});

test('stepsFor: lanes split by background, a match filters on its payload field', () => {
  assert.deepEqual(stepsFor('SessionStart', 'background').map((s) => s.script), ['hooks/prune-cache-hook.js', 'bridge/ensure.mjs']);
  assert.deepEqual(stepsFor('SessionStart', 'foreground').map((s) => s.script), ['hooks/sync-hook.js', 'hooks/setup-check-hook.js', 'setup/doctor.js']);
  assert.deepEqual(stepsFor('Notification', 'foreground', { notification_type: 'auth_success' }).map((s) => s.script), ['hooks/notify-hook.js']);
  assert.deepEqual(stepsFor('Notification', 'foreground', { notification_type: 'permission_prompt_x' }).map((s) => s.script), ['hooks/notify-hook.js'], 'anchored');
  assert.deepEqual(stepsFor('Nope', 'foreground'), []);
});

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
    const out = await runSteps(steps, '{}', 'SessionStart', { run: (s, raw) => runStep(s, raw, { scriptsDir: dir }) });
    assert.ok(Date.now() - t0 < 4000, 'no step waits on its budget but the spinning one, terminated at 0.5 s');
    assert.deepEqual(out.ccConfigSync, { pulled: 1 });
    assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: 'ctx' });
    const lines = out.systemMessage.split('\n');
    assert.equal(lines[0], 'first');
    assert.match(lines[1], /^\[claude-hook\] SessionStart: throws\.mjs failed: boom$/);
    assert.deepEqual(lines.slice(2), ['said before exit', '[claude-hook] SessionStart: exits.mjs exited 3',
      '[claude-hook] SessionStart: spins.mjs timed out after 0.5s', 'last']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing step script is a named failure, not a silent no-op', async () => {
  const r = await runStep({ script: 'hooks/absent.mjs', budgetMs: 5000 }, '{}', { scriptsDir: os.tmpdir() });
  assert.match(failureOf({ script: 'hooks/absent.mjs', budgetMs: 5000 }, r), /^hooks\/absent\.mjs (failed|exited)/);
});

test('mergeOutputs: silent steps add nothing; plain text is shown, never injected as context', () => {
  assert.deepEqual(mergeOutputs([{ step: { script: 'a' }, out: '' }, { step: { script: 'b' }, out: '  ' }], 'SessionStart'), {});
  assert.deepEqual(mergeOutputs([{ step: { script: 'x.js' }, out: 'hello' }], 'SessionStart'), { systemMessage: '[x.js] hello' });
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
