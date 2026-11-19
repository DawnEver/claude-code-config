#!/usr/bin/env node
// agy-hook.mjs: the one managed Antigravity CLI (agy) hook entry, `--event E`.
// Wired by setup into ~/.gemini/config/hooks.json as the named hook `cc-config`
// (scripts/setup/agy-config.mjs). agy hooks are synchronous and block the agent loop,
// so anything slow (a git pull, starting the bridge daemon) runs in a detached child.
// Contracts are agy's (camelCase stdin/stdout); PreToolUse requires a non-empty `decision`
// (`{}` is treated by agy as an empty-decision denial), so neutral pass-through and fail-open
// on PreToolUse emit `{"decision":"ask"}` (defers to the user's configured toolPermission).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { isMain } from '../shared/is-main.mjs';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
export const AGY_HOME = path.join(os.homedir(), '.gemini', 'config');
const hooksDir = home => path.join(home, 'harness-hooks');

const isPreToolArgv = (argv = process.argv) => {
  const i = argv.indexOf('--event');
  return i >= 0 && argv[i + 1] === 'PreToolUse';
};
export const neutralJson = (argv = process.argv) => isPreToolArgv(argv) ? '{"decision":"ask"}' : '{}';

/** One step agy injects into the conversation (SessionStart / PreInvocation). */
export const systemStep = text => ({ systemMessage: { systemMessage: text } });

export function agyNotification(input, event) {
  const cwd = input.cwd || input.workspacePaths?.[0] || '';
  const project = path.basename(cwd || 'workspace');
  if (event !== 'Stop' || input.terminationReason === 'USER_CANCELED') return null;
  if (input.terminationReason === 'ERROR') return { title: 'Antigravity - Error', message: `Stopped on an error in: ${project}`, cwd };
  return { title: 'Antigravity - Done', message: `Task completed in: ${project}`, cwd };
}

function recordReceipt(event, home, definition) {
  if (!/^[a-f0-9]{64}$/.test(definition ?? '')) return;
  const dir = hooksDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${event}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), definition }));
  fs.renameSync(tmp, target);
}

function detached(args) {
  const child = spawn(process.execPath, [SELF, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// A loop-guard warning cannot ride PreToolUse alongside an explanation without denying, and `allow`
// would skip the user's permission prompt. `ask` defers to toolPermission while the warning waits
// for the next PreInvocation, which injects it.
const warnFile = (home, conversationId) =>
  path.join(hooksDir(home), 'pending', `${crypto.createHash('sha256').update(String(conversationId)).digest('hex').slice(0, 32)}.txt`);
function stashWarning(home, conversationId, reason) {
  const file = warnFile(home, conversationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${reason}\n`);
}
function takeWarnings(home, conversationId) {
  const file = warnFile(home, conversationId);
  try { const text = fs.readFileSync(file, 'utf8').trim(); fs.rmSync(file, { force: true }); return text; } catch { return ''; }
}

async function loadBridge() {
  const file = path.join(SCRIPTS, 'bridge', 'agy-adapter.mjs');
  if (!fs.existsSync(file)) return null;
  return (await import('../bridge/agy-adapter.mjs')).forwardAgyHook ?? null;
}

const BRIDGE_EVENTS = new Set(['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);

/**
 * @param {object} input agy's stdin payload, `hookEventName` set (from --event when given)
 * @param {object} deps  test seams; production uses the real modules
 */
export async function runAgyHook(input, deps = {}) {
  const event = input.hookEventName;
  const env = deps.env ?? process.env;
  const home = deps.agyHome ?? AGY_HOME;
  const messages = [];
  const attempt = async fn => {
    try { return await fn(); } catch (e) { messages.push(`[cc-config] ${e.message}`); return null; }
  };
  await attempt(() => (deps.receipt ?? recordReceipt)(event, home, deps.definition));

  const forwardBridge = () => attempt(async () => {
    const forward = deps.bridge !== undefined ? deps.bridge : await loadBridge();
    return forward ? await forward(event, input) : null;
  });
  const runProject = () => attempt(async () => {
    if (deps.projectHooks !== undefined) return deps.projectHooks ? await deps.projectHooks(event, input) : null;
    if (deps.agyHome !== undefined) return null; // isolated unit tests unless projectHooks explicitly supplied
    const [{ runProjectGuards }, { isAgyMainSession }] = await Promise.all([
      import('./project-guard-bridge.mjs'),
      import('../bridge/agy-adapter.mjs'),
    ]);
    const isSubagent = Boolean(input.conversationId) && !isAgyMainSession(input, { env, ancestry: false });
    return runProjectGuards(event, input, { host: 'agy', env, isSubagent });
  });
  // PreToolUse forwards after the loop guard and project guard: a denied call never reaches Telegram.
  const bridged = BRIDGE_EVENTS.has(event) && event !== 'PreToolUse' ? await forwardBridge() : null;

  if (event === 'SessionStart') {
    // Slow, network-bound work leaves the agent loop: pull + bridge daemon.
    await attempt(() => (deps.background ?? (() => detached(['--background-start'])))());
    const healed = await attempt(deps.heal ?? (async () => (await import('../setup/check-links.js')).checkLinks()));
    if (healed?.warnings?.length) messages.push(`[setup-check] ${healed.warnings.join('; ')}`);
    // `--hook` reports the last run's FAILs at once and refreshes detached.
    const checked = await attempt(deps.doctor ?? (() => JSON.parse(execFileSync(process.execPath,
      [path.join(SCRIPTS, 'setup', 'doctor.js'), '--hook'], { encoding: 'utf8', timeout: 8000, windowsHide: true }) || '{}')));
    if (checked?.systemMessage) messages.push(checked.systemMessage);
    const proj = await runProject();
    if (proj?.contexts?.length) messages.push(...proj.contexts);
  } else if (event === 'PreToolUse') {
    const result = await attempt(deps.guard ?? (async () => (await import('./loop-guard-hook.js')).guardCall(input, { env, host: 'agy' })));
    if (result?.verdict === 'deny') return { decision: 'deny', reason: result.reason };
    if (result?.verdict === 'warn' && input.conversationId) await attempt(() => stashWarning(home, input.conversationId, result.reason));
    const proj = await runProject();
    if (proj?.denyReason) return { decision: 'deny', reason: proj.denyReason };
    if (proj?.contexts?.length && input.conversationId) await attempt(() => stashWarning(home, input.conversationId, proj.contexts.join('\n')));
    // The adapter may answer for the user (a Telegram question or approval); it can wait up to 600 s.
    const answer = await forwardBridge();
    if (answer?.decision) return answer.reason ? { decision: answer.decision, reason: answer.reason } : { decision: answer.decision };
    if (proj?.allowDoor) return { decision: 'allow' };
    return { decision: 'ask' };
  } else if (event === 'PreInvocation') {
    // A Telegram interrupt stops the turn before the model runs.
    if (bridged?.terminate) return { terminationBehavior: 'terminate', injectSteps: [{ errorMessage: { userMessage: bridged.reason || 'Interrupted.' } }] };
    const pending = input.conversationId ? takeWarnings(home, input.conversationId) : '';
    if (pending) messages.push(pending);
    const proj = await runProject();
    if (proj?.contexts?.length) messages.push(...proj.contexts);
  } else if (event === 'Stop') {
    const proj = await runProject();
    if (proj?.blockReason && !input.continuationActive) return { decision: 'continue', reason: proj.blockReason };
    const notification = agyNotification(input, event);
    if (notification) await attempt(() => (deps.notify ?? (n => detached(['--send-notification', JSON.stringify(n)])))(notification));
    // agy has no SessionEnd: a finished, idle turn is the closest point for the repo reminder.
    if (input.fullyIdle !== false && !input.continuationActive)
      await attempt(() => (deps.remind ?? (() => detached(['--remind'])))());
    // Queued Telegram input re-enters the loop. The adapter is the authority on what is new, so a
    // message that arrives during a continuation still gets through; it never repeats one.
    const reason = bridged?.stopContinue;
    if (reason) return { decision: 'continue', reason };
    return {};
  }

  if (event === 'PostToolUse') {
    const proj = await runProject();
    if (proj?.contexts?.length && input.conversationId) await attempt(() => stashWarning(home, input.conversationId, proj.contexts.join('\n')));
    return {};
  }
  const steps = [...(bridged?.injectSteps ?? [])];
  if (messages.length && ['SessionStart', 'PreInvocation'].includes(event)) steps.push(systemStep(messages.join('\n')));
  return steps.length ? { injectSteps: steps } : {};
}

async function backgroundStart() {
  try {
    const { syncBeforeLaunch } = await import('../runtime/startup-sync.mjs');
    const result = syncBeforeLaunch({ env: { ...process.env, CC_CONFIG_STARTUP_SYNCED: process.env.CC_CONFIG_STARTUP_SYNCED ?? '' },
      stampFile: path.join(os.homedir(), '.claude', '.harness-startup-sync') });
    if (result?.pulled > 0) (await import('../setup/check-links.js')).checkLinks();
  } catch { /* a pull must never break a session */ }
  try { await (await import('../bridge/ensure.mjs')).ensureDaemon(); } catch { /* bridge is optional */ }
}

async function remind() {
  const { boundedRepoReminder } = await import('./sync-hook.js');
  const notice = await boundedRepoReminder({ budgetMs: 5000 });
  if (!notice) return;
  const file = path.join(hooksDir(AGY_HOME), 'last-reminder.json');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first */ }
  // Every idle stop would repeat it; notify once per distinct state per hour.
  if (last?.message === notice && Date.now() - Date.parse(last.at) < 3600000) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), message: notice }));
  await sendNotification({ title: 'Antigravity - Config reminder', message: notice, cwd: '' });
}

async function sendNotification(n) {
  const { readMergedEnvSettings, ENV_SETTINGS_PATH } = await import('../shared/config.mjs');
  const options = readMergedEnvSettings({ sharedPath: ENV_SETTINGS_PATH })?.harness?.notifications ?? {};
  if (options.enabled !== true) return;
  const { sendNativeNotification } = await import('./notify-hook.js');
  sendNativeNotification(n.title, n.message, options.open ? n.cwd : '', options.sound !== false);
}

async function main() {
  const argv = process.argv;
  if (process.env.CC_CONFIG_AGY_SMOKE === '1') return void process.stdout.write(neutralJson(argv));
  if (argv.includes('--background-start')) return backgroundStart();
  if (argv.includes('--remind')) return remind();
  if (argv.includes('--send-notification')) return sendNotification(JSON.parse(argv[argv.indexOf('--send-notification') + 1]));
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2 ** 22) break; }
  const input = JSON.parse(raw || '{}');
  const eventIndex = argv.indexOf('--event');
  if (eventIndex >= 0) input.hookEventName = argv[eventIndex + 1];
  const definitionIndex = argv.indexOf('--definition');
  process.stdout.write(JSON.stringify(await runAgyHook(input, { definition: definitionIndex >= 0 ? argv[definitionIndex + 1] : null })));
}

// A hook that exits non-zero or returns `{}` on PreToolUse blocks every agy tool call.
if (isMain(import.meta.url)) {
  const failOpen = () => { try { process.stdout.write(neutralJson()); } catch { /* closed pipe */ } process.exit(0); };
  process.on('uncaughtException', failOpen);
  process.on('unhandledRejection', failOpen);
  main().then(() => process.exit(0), failOpen);
}
