import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAgyHook, agyNotification } from './agy-hook.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const noop = async () => null;
function deps(t, extra = {}) {
  const agyHome = tempDir('agy-hook-');
  t.after(() => fs.rmSync(agyHome, { recursive: true, force: true }));
  return { agyHome, env: {}, bridge: null, background: noop, heal: noop, doctor: noop, guard: noop, notify: noop, remind: noop, ...extra };
}

test('SessionStart backgrounds slow work and injects FAILs as a system step', async t => {
  let backgrounded = false;
  const out = await runAgyHook({ hookEventName: 'SessionStart' }, deps(t, {
    background: async () => { backgrounded = true; },
    heal: async () => ({ warnings: ['GEMINI.md: drifted'] }),
    doctor: async () => ({ systemMessage: 'doctor: 1 FAIL' }),
  }));
  assert.equal(backgrounded, true);
  assert.equal(out.injectSteps.length, 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /GEMINI\.md: drifted[\s\S]*doctor: 1 FAIL/);
});

test('SessionStart healthy is silent and writes a receipt for a valid definition', async t => {
  const d = deps(t, { definition: 'a'.repeat(64), receipt: undefined });
  delete d.receipt;
  assert.deepEqual(await runAgyHook({ hookEventName: 'SessionStart' }, d), {});
  const receipt = JSON.parse(fs.readFileSync(path.join(d.agyHome, 'harness-hooks', 'SessionStart.json'), 'utf8'));
  assert.equal(receipt.definition, 'a'.repeat(64));
});

test('PreToolUse deny maps to agy decision; warn waits for the next PreInvocation', async t => {
  const d = deps(t, { guard: async () => ({ verdict: 'deny', reason: 'loop' }) });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreToolUse', conversationId: 'c', toolCall: { name: 'run_command' } }, d), { decision: 'deny', reason: 'loop' });
  d.guard = async () => ({ verdict: 'warn', reason: 'third identical call' });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreToolUse', conversationId: 'c', toolCall: { name: 'run_command' } }, d), { decision: 'ask' }, 'defers to toolPermission, never empty {}');
  const next = await runAgyHook({ hookEventName: 'PreInvocation', conversationId: 'c' }, d);
  assert.match(next.injectSteps[0].systemMessage.systemMessage, /third identical call/);
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreInvocation', conversationId: 'c' }, d), {}, 'consumed once');
});

test('bridge results merge: injectSteps, PreToolUse forwarded, Stop continue passed through', async t => {
  const seen = [];
  const d = deps(t, { bridge: async (event, input) => { seen.push(event); return event === 'Stop' ? { stopContinue: 'Telegram: hi' } : { injectSteps: [{ userMessage: 'x' }] }; } });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreInvocation' }, d), { injectSteps: [{ userMessage: 'x' }] });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PostToolUse' }, d), {});
  assert.deepEqual(await runAgyHook({ hookEventName: 'Stop', fullyIdle: true }, d), { decision: 'continue', reason: 'Telegram: hi' });
  assert.deepEqual(await runAgyHook({ hookEventName: 'Stop', continuationActive: true }, d), { decision: 'continue', reason: 'Telegram: hi' }, 'the adapter decides what is new');
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreToolUse', toolCall: {} }, d), { decision: 'ask' });
  assert.deepEqual(seen, ['PreInvocation', 'PostToolUse', 'Stop', 'Stop', 'PreToolUse']);
});

test('Stop notifies and reminds only when idle and not continuing', async t => {
  const calls = [];
  const d = deps(t, { notify: async n => calls.push(n.title), remind: async () => calls.push('remind') });
  await runAgyHook({ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: true, cwd: '/w/proj' }, d);
  await runAgyHook({ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', fullyIdle: false }, d);
  assert.deepEqual(calls, ['Antigravity - Done', 'remind', 'Antigravity - Done']);
  assert.equal(agyNotification({ terminationReason: 'USER_CANCELED' }, 'Stop'), null);
});

test('bridge answers: PreToolUse decision after the guard, PreInvocation terminate', async t => {
  const seen = [];
  const d = deps(t, { bridge: async event => { seen.push(event); return event === 'PreToolUse' ? { decision: 'deny', reason: 'no from Telegram' } : { terminate: true, reason: 'stop' }; } });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreToolUse', toolCall: {} }, d), { decision: 'deny', reason: 'no from Telegram' });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreInvocation' }, d), { terminationBehavior: 'terminate', injectSteps: [{ errorMessage: { userMessage: 'stop' } }] });
  d.bridge = async event => event === 'PreToolUse' ? { decision: 'allow' } : { terminate: true };
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreToolUse', toolCall: {} }, d), { decision: 'allow' });
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreInvocation' }, d), { terminationBehavior: 'terminate', injectSteps: [{ errorMessage: { userMessage: 'Interrupted.' } }] });
  d.guard = async () => ({ verdict: 'deny', reason: 'loop' });
  seen.length = 0;
  assert.deepEqual(await runAgyHook({ hookEventName: 'PreToolUse', toolCall: {} }, d), { decision: 'deny', reason: 'loop' });
  assert.deepEqual(seen, [], 'a guard deny never reaches Telegram');
});

test('a throwing bridge fails open', async t => {
  const d = deps(t, { bridge: async () => { throw new Error('ipc down'); } });
  assert.deepEqual(await runAgyHook({ hookEventName: 'Stop', continuationActive: true }, d), {});
});

test('CLI: any failure fails open (ask on PreToolUse, {} elsewhere) and exits 0', () => {
  const script = fileURLToPath(new URL('./agy-hook.mjs', import.meta.url));
  const tmpHome = tempDir('agy-cli-');
  try {
    for (const [args, input, env, expected] of [
      [['--event', 'PreToolUse'], '{}', { HOME: tmpHome, USERPROFILE: tmpHome }, '{"decision":"ask"}'],
      [['--event', 'PreToolUse'], 'not json', { HOME: tmpHome, USERPROFILE: tmpHome }, '{"decision":"ask"}'],
      [['--event', 'PostToolUse'], 'not json', { HOME: tmpHome, USERPROFILE: tmpHome }, '{}'],
      [['--send-notification', 'not json'], '', { HOME: tmpHome, USERPROFILE: tmpHome }, '{}'],
      [['--event', 'PreToolUse'], '{}', { CC_CONFIG_AGY_SMOKE: '1', HOME: tmpHome, USERPROFILE: tmpHome }, '{"decision":"ask"}'],
    ]) {
      const r = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });
      assert.equal(r.status, 0, args.join(' '));
      assert.equal(r.stdout, expected, args.join(' '));
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
