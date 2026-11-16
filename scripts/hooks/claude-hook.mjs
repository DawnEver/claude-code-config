#!/usr/bin/env node
// claude-hook.mjs — ONE Claude Code hook entry for an event that several hook scripts serve.
//
//   node ~/.claude/scripts/hooks/claude-hook.mjs --event SessionStart
//   node ~/.claude/scripts/hooks/claude-hook.mjs --event Notification
//
// A node process per hook script is the cost this removes (a bare `node` boot is ~0.5 s on
// Windows): STEPS lists, per event, the scripts that event runs, in order, and this entry runs
// each one in a worker thread of its own process -- the script unchanged, launched exactly as
// its own command would launch it (argv, the hook payload on stdin, its stdout captured).
//
// Each step is isolated: a throw, an exit code or a budget overrun ends that step only (a
// worker is terminated at its budget, even mid-loop) and the next step still runs. A failed
// step is NAMED in the merged systemMessage, never swallowed. Outputs merge into one JSON
// object: systemMessage and additionalContext joined by newlines, other keys last-wins.
//
// A `background` step was an `async` hook: it must not hold the session. The entry hands all of
// an event's background steps, in order, to ONE detached copy of itself (`--lane background`)
// before it runs the foreground ones, so they start as early as they used to.
// The settings timeout of an entry covers the sum of its foreground budgets (a test checks it).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { isMain } from '../shared/is-main.mjs';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));

/**
 * Per event, the hook scripts it runs, in order. `script` is relative to scripts/; `budgetMs` is
 * the timeout its own settings entry had; `match` filters on a payload field as a settings
 * matcher did; `background` marks a step that ran `async`.
 */
export const STEPS = {
  SessionStart: [
    { script: 'hooks/sync-hook.js', args: ['--pull-background'], budgetMs: 10000 },
    { script: 'hooks/prune-cache-hook.js', budgetMs: 10000, background: true },
    { script: 'hooks/setup-check-hook.js', budgetMs: 5000 },
    { script: 'setup/doctor.js', args: ['--hook'], budgetMs: 10000 },
    { script: 'bridge/ensure.mjs', budgetMs: 10000, background: true },
  ],
  Notification: [
    { script: 'hooks/notify-hook.js', budgetMs: 60000 },
    { script: 'hooks/bridge-hook.js', budgetMs: 10000,
      match: { field: 'notification_type', pattern: 'permission_prompt|idle_prompt|elicitation_dialog' } },
  ],
};

/** The steps of `event` that run in `lane` ('foreground' | 'background') for `payload`. */
export function stepsFor(event, lane, payload = {}, steps = STEPS) {
  return (steps[event] ?? []).filter((s) => (lane === 'background') === Boolean(s.background) &&
    (!s.match || new RegExp(`^(?:${s.match.pattern})$`).test(String(payload?.[s.match.field] ?? ''))));
}

// The worker's first module: give the step the argv its own command line had and the payload
// as its stdin, then load it, so its entry guard (isMain) fires exactly as when it was launched
// by its own settings entry. The stdin is an in-thread stream, not the worker's `stdin: true`
// port: that port keeps the thread alive until read, and most steps never read it.
const BOOT = new URL(`data:text/javascript,${encodeURIComponent(
  "import { workerData } from 'node:worker_threads';" +
  "import { pathToFileURL } from 'node:url';" +
  "import { Readable } from 'node:stream';" +
  'process.argv = [process.execPath, workerData.file, ...workerData.args];' +
  "Object.defineProperty(process, 'stdin', { value: Readable.from([workerData.raw]), configurable: true });" +
  'await import(pathToFileURL(workerData.file).href);')}`);

/**
 * Run one hook script in a worker thread of this process, `raw` on its stdin.
 * Resolves `{ out, err, code, timedOut, error }`; never rejects.
 */
export function runStep({ script, args = [], budgetMs }, raw, { scriptsDir = SCRIPTS } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', error = null, timedOut = false, worker;
    try {
      worker = new Worker(BOOT, { workerData: { file: path.join(scriptsDir, script), args, raw }, stdout: true, stderr: true });
    } catch (e) { resolve({ out, err, code: 1, timedOut, error: e.message }); return; }
    worker.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    worker.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    worker.on('error', (e) => { error = e?.message ?? String(e); });
    const timer = setTimeout(() => { timedOut = true; worker.terminate(); }, budgetMs);
    worker.on('exit', (code) => { clearTimeout(timer); resolve({ out, err, code, timedOut, error }); });
  });
}

/** One step's outcome as a notice, or null when it ended cleanly. */
export function failureOf(step, { code, timedOut, error }) {
  if (timedOut) return `${step.script} timed out after ${step.budgetMs / 1000}s`;
  if (error) return `${step.script} failed: ${error}`;
  if (code) return `${step.script} exited ${code}`;
  return null;
}

/** Merge the stdout of several hook scripts and the notices of the failed ones into one hook output. */
export function mergeOutputs(results, event) {
  const merged = {}, messages = [], contexts = [];
  for (const { step, out, failure } of results) {
    const text = String(out ?? '').trim();
    if (text) {
      let o = null;
      try { o = JSON.parse(text); } catch { /* not JSON */ }
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const { systemMessage, hookSpecificOutput, ...rest } = o;
        Object.assign(merged, rest);
        if (systemMessage) messages.push(systemMessage);
        if (hookSpecificOutput?.additionalContext) contexts.push(hookSpecificOutput.additionalContext);
      } else messages.push(`[${step.script}] ${text}`);
    }
    if (failure) messages.push(`[claude-hook] ${event}: ${failure}`);
  }
  if (messages.length) merged.systemMessage = messages.join('\n');
  if (contexts.length) merged.hookSpecificOutput = { hookEventName: event, additionalContext: contexts.join('\n') };
  return merged;
}

/** Run `steps` in order, each isolated and within its own budget; the merged hook output. */
export async function runSteps(steps, raw, event, { run = runStep } = {}) {
  const results = [];
  for (const step of steps) {
    const r = await run(step, raw);
    if (r.err) process.stderr.write(r.err);
    results.push({ step, out: r.out, failure: failureOf(step, r) });
  }
  return mergeOutputs(results, event);
}

/** Start this event's background steps in one detached copy of this entry, the payload on its stdin. */
export function startBackgroundLane(event, raw, { run = spawn } = {}) {
  const child = run(process.execPath, [fileURLToPath(import.meta.url), '--event', event, '--lane', 'background'],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
  child.unref();
}

const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

async function main() {
  const event = argOf('--event');
  const lane = argOf('--lane') ?? 'foreground';
  if (!STEPS[event]) { process.stderr.write(`[claude-hook] unknown event ${event}; known: ${Object.keys(STEPS).join(', ')}\n`); return; }
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* the steps parse it themselves */ }
  if (lane === 'foreground' && stepsFor(event, 'background', payload).length) startBackgroundLane(event, raw);
  const output = await runSteps(stepsFor(event, lane, payload), raw, event);
  // Flushed before exit: stdout may be an asynchronous pipe.
  if (lane === 'foreground' && Object.keys(output).length) await new Promise((done) => process.stdout.write(JSON.stringify(output), done));
}

// Exit once done: a terminated or lingering step must not hold the hook open.
if (isMain(import.meta.url)) main().catch((e) => process.stderr.write(`[claude-hook] ${e.message}\n`)).finally(() => process.exit(0));
