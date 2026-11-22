#!/usr/bin/env node
// One native machine-hook entry. Plugin hooks remain owned by their plugin bundles.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { isMain } from '../shared/is-main.mjs';
import { resolveCodexHome } from '../shared/codex-home.mjs';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));
const homeOf = env => resolveCodexHome({ env });

export function codexNotification(input, event = input.type) {
  const project = path.basename(input.cwd || 'workspace');
  if (event === 'agent-turn-complete') return { title: 'Codex — Done', message: `Task completed in: ${project}`, cwd: input.cwd || '' };
  if (event === 'PermissionRequest') return { title: 'Codex — Approval', message: `Waiting for approval in: ${project}`, cwd: input.cwd || '' };
  if (event === 'UserInputRequest') return { title: 'Codex — Input', message: `Waiting for your response in: ${project}`, cwd: input.cwd || '' };
  return null;
}

async function recordReceipt(event, env, definition) {
  if (!/^[a-f0-9]{64}$/.test(definition ?? '')) return;
  const dir = path.join(homeOf(env), 'harness-hooks');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${event}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), definition }));
  fs.renameSync(tmp, target);
}

function notifyDetached(notification) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send-notification', JSON.stringify(notification)],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function reportPluginCache(env) {
  const dir = path.join(homeOf(env), 'harness-hooks');
  const file = path.join(dir, 'cache-report.json');
  try { if (Date.now() - fs.statSync(file).mtimeMs < 86400000) return; } catch { /* first audit */ }
  const candidates = [];
  const { prune } = await import('./prune-cache-hook.js');
  prune({ reportOnly: true, log: line => { if (candidates.length < 100) candidates.push(line); } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reportOnly: true, candidates }, null, 2));
}

function reminderSink(message, env) {
  const dir = path.join(homeOf(env), 'harness-hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-reminder.json'), JSON.stringify({ at: new Date().toISOString(), message }));
  process.stderr.write(message + '\n');
  notifyDetached({ title: 'Codex — Config reminder', message, cwd: '' });
}

export async function runCodexHook(input, deps = {}) {
  const event = input.hook_event_name;
  const env = deps.env ?? process.env;
  const messages = [];
  const attempt = async fn => {
    try { return await fn(); } catch (e) { messages.push(`[cc-config] ${e.message}`); return null; }
  };
  const runProject = () => attempt(async () => {
    if (deps.projectHooks !== undefined) return deps.projectHooks ? await deps.projectHooks(event, input) : null;
    if (deps.sync || deps.heal || deps.guard || deps.remind || deps.notify) return null; // isolated unit tests unless projectHooks supplied
    const { runProjectGuards } = await import('./project-guard-bridge.mjs');
    const isSubagent = Boolean(
      input.agent_id
      || (env.CODEX_THREAD_ID && env.CODEX_SESSION_ID && env.CODEX_THREAD_ID !== env.CODEX_SESSION_ID),
    );
    return runProjectGuards(event, input, { host: 'codex', env, isSubagent });
  });
  const repair = async (quick = false) => {
    const result = await attempt(() => (deps.repair ?? (async options =>
      (await import('../setup/update-codex-plugins.mjs')).repairProtectedPluginCaches(options)))({ codexHome: homeOf(env), quick }));
    if (result?.status === 'deferred') messages.push('[cc-config] Protected cache repair deferred within the tool-start budget; run node scripts/setup/update-codex-plugins.mjs --repair in cc-config when idle.');
    return result;
  };
  if (['SessionStart', 'PreToolUse', 'PermissionRequest', 'SessionEnd'].includes(event))
    await attempt(() => (deps.receipt ?? recordReceipt)(event, env, deps.definition));
  if (event === 'SessionStart' && (!input.source || ['startup', 'resume', 'fork'].includes(input.source))) {
    if (!input.source || input.source === 'startup') {
      const syncOptions = { env: { ...env, CC_CONFIG_STARTUP_SYNCED: '' },
        stampFile: path.join(os.homedir(), '.claude', '.harness-startup-sync') };
      const result = await attempt(() => (deps.sync ?? (async options => {
        const { syncBeforeLaunch } = await import('../runtime/startup-sync.mjs');
        return syncBeforeLaunch(options);
      }))(syncOptions));
      if (result?.notice) messages.push(result.notice);
    }
    // Import only after synchronization, in order: matching native handlers run concurrently.
    const healed = await attempt(deps.heal ?? (async () => (await import('../setup/check-links.js')).checkLinks()));
    if (healed?.warnings?.length) messages.push(`[setup-check] ${healed.warnings.join('; ')}`);
    await repair();
    const checked = await attempt(deps.doctor ?? (() => {
      const result = execFileSync(process.execPath, [path.join(SCRIPTS, 'setup', 'doctor.js'), '--hook'],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      return JSON.parse(result || '{}');
    }));
    if (checked?.systemMessage) messages.push(checked.systemMessage);
    await attempt(deps.cacheReport ?? (deps.heal ? async () => {} : () => reportPluginCache(env)));
    // Also records this session's CODEX_HOME, so the daemon bridges it under its own account.
    await attempt(deps.ensure ?? (deps.sync ? async () => {} : async () => {
      await (await import('../bridge/ensure.mjs')).ensureDaemon();
    }));
    const proj = await runProject();
    if (proj?.contexts?.length) messages.push(...proj.contexts);
  } else if (event === 'PreToolUse') {
    await repair(true);
    // A daemon that died mid-session would otherwise stay down until some session starts:
    // a Codex-only host would drop off the dashboard and Telegram while its sessions run on.
    await attempt(deps.revive ?? (deps.guard ? async () => {} : async () => {
      const { daemonRunning, ensureDaemon } = await import('../bridge/ensure.mjs');
      if (!daemonRunning()) await ensureDaemon();
    }));
    const result = await attempt(deps.guard ?? (async () => (await import('./loop-guard-hook.js')).guardCall(input, { env, host: 'codex' })));
    if (result?.verdict === 'deny') return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: result.reason } };
    const proj = await runProject();
    if (proj?.denyReason) return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: proj.denyReason } };
    const contexts = [
      ...(result?.verdict === 'warn' ? [result.reason] : []),
      ...(proj?.contexts ?? []),
    ];
    if (['request_user_input', 'request_user_input_async', 'AskUserQuestion'].includes(String(input.tool_name).split('.').at(-1)))
      await attempt(() => (deps.notify ?? notifyDetached)(codexNotification(input, 'UserInputRequest')));
    if (contexts.length) return { hookSpecificOutput: { hookEventName: event, additionalContext: contexts.join('\n') } };
  } else if (event === 'PermissionRequest') {
    await attempt(() => (deps.notify ?? notifyDetached)(codexNotification(input, event)));
  } else if (event === 'SessionEnd') {
    const proj = await runProject();
    if (proj?.contexts?.length) messages.push(...proj.contexts);
    const notice = await attempt(deps.remind ?? (async () => (await import('./sync-hook.js')).boundedRepoReminder()));
    if (notice) {
      messages.push(notice);
      await attempt(() => (deps.reminderSink ?? (deps.remind ? () => {} : reminderSink))(notice, env));
    }
  }
  // Receipts are diagnostic evidence, not hook-trust decisions. Never persist raw input.
  return messages.length ? { systemMessage: messages.join('\n') } : {};
}

async function main() {
  if (process.argv.includes('--send-notification')) {
    const n = JSON.parse(process.argv[process.argv.indexOf('--send-notification') + 1]);
    const { readMergedEnvSettings, ENV_SETTINGS_PATH } = await import('../shared/config.mjs');
    const options = readMergedEnvSettings({ sharedPath: ENV_SETTINGS_PATH })?.harness?.notifications ?? {};
    if (options.enabled !== true) return;
    const { sendNativeNotification } = await import('./notify-hook.js');
    sendNativeNotification(n.title, n.message, options.open ? n.cwd : '', options.sound !== false);
    return;
  }
  if (process.argv.includes('--notify')) {
    const input = JSON.parse(process.argv[process.argv.indexOf('--notify') + 1] || '{}');
    const notification = codexNotification(input);
    if (notification) notifyDetached(notification);
    return;
  }
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2 ** 20) return; }
  const input = JSON.parse(raw || '{}');
  const eventIndex = process.argv.indexOf('--event');
  if (eventIndex >= 0) input.hook_event_name = process.argv[eventIndex + 1];
  const definitionIndex = process.argv.indexOf('--definition');
  process.stdout.write(JSON.stringify(await runCodexHook(input, { definition: definitionIndex >= 0 ? process.argv[definitionIndex + 1] : null })));
}

if (isMain(import.meta.url)) main().catch(() => process.stdout.write('{}'));
