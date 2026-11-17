#!/usr/bin/env node
// claude-hook.mjs — ONE Claude Code hook entry for an event that several hook scripts serve.
//
//   node ~/.claude/scripts/hooks/claude-hook.mjs --event SessionStart
//   node ~/.claude/scripts/hooks/claude-hook.mjs --event Notification
//   node ~/.claude/scripts/hooks/claude-hook.mjs --event PreToolUse
//
// A node process per hook script is the cost this removes (a bare `node` boot is ~0.5 s on
// Windows): STEPS lists, per event, the scripts that event runs, in order, and this entry runs
// each one in a worker thread of its own process -- the script unchanged, launched exactly as
// its own command would launch it (argv, the hook payload on stdin, its stdout captured).
//
// Each step is isolated: a throw, an exit code or a budget overrun ends that step only (a
// worker is terminated at its budget, even mid-loop) and the next step still runs. A failed
// step is NAMED in the merged systemMessage, never swallowed. Outputs merge into one JSON
// object: systemMessage and additionalContext joined by newlines, the strictest permission
// decision (with its reason and updatedInput) wins, other keys last-wins. A step that denies, or
// exits 2 (a block: the entry exits 2 with its stderr), ends the run: its call will not happen.
//
// A `background` step was an `async` hook: it must not hold the session. The entry hands all of
// an event's background steps, in order, to ONE detached copy of itself (`--lane background`)
// before it runs the foreground ones, so they start as early as they used to.
// The settings timeout of an entry (at most 5 s) covers wallBudgetMs of its foreground steps (a test checks it).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { isMain } from '../shared/is-main.mjs';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));

/**
 * Per event, the hook scripts it runs, in order. `script` is relative to scripts/; `budgetMs` is
 * the timeout its own settings entry had; `match` filters on a payload field as a settings
 * matcher did. A step that ran `async` is `background` (the detached lane: nothing may wait on
 * it) or `concurrent` (this process, started beside the ordered steps the call waits on anyway).
 */
// Every hook < 5 s, for the whole EVENT (user ruling D24, 2026-11-17): an event's foreground
// steps fit wallBudgetMs <= 4500 (a test checks), and each one is fast or hands its slow part
// to a detached process (sync-hook's pull, doctor's checks, bridge-hook's spool sender).
export const STEPS = {
  SessionStart: [
    { script: 'hooks/sync-hook.js', args: ['--pull-background'], budgetMs: 1000 },
    { script: 'hooks/prune-cache-hook.js', budgetMs: 10000, background: true },
    { script: 'hooks/setup-check-hook.js', budgetMs: 2000 },
    { script: 'setup/doctor.js', args: ['--hook'], budgetMs: 1500 },
    { script: 'bridge/ensure.mjs', budgetMs: 10000, background: true },
    // /clear and /resume rename the session: file a request for the background learner of its
    // claude process and keep this process up (beside the rest, at most 3 s) until its snapshot.
    { script: 'hooks/bridge-hook.js', args: ['--learn'], budgetMs: 3500, concurrent: true, match: { field: 'source', pattern: 'clear|resume' } },
  ],
  Notification: [
    { script: 'hooks/notify-hook.js', budgetMs: 3000 },
    { script: 'hooks/bridge-hook.js', budgetMs: 1500,
      match: { field: 'notification_type', pattern: 'permission_prompt|idle_prompt|elicitation_dialog' } },
  ],
  // Every tool call. The bridge's activity edge and task (a foreground shell on the board) runs
  // beside the guard, as its own async entry did, so the call waits on neither twice. The question
  // call of AskUserQuestion runs after the guard: a denied question is never posted.
  PreToolUse: [
    { script: 'hooks/loop-guard-hook.js', budgetMs: 1500 },
    { script: 'hooks/bridge-hook.js', args: ['--question'], budgetMs: 1500, match: { field: 'tool_name', pattern: 'AskUserQuestion' } },
    { script: 'hooks/bridge-hook.js', budgetMs: 1500, concurrent: true, match: { field: 'tool_name', pattern: '(?!AskUserQuestion$).*' } },
  ],
};

/** The longest an entry can take for `steps`: its ordered steps one after another, its concurrent ones beside them. */
export function wallBudgetMs(steps) {
  const ordered = steps.filter((s) => !s.concurrent).reduce((t, s) => t + s.budgetMs, 0);
  return Math.max(ordered, ...steps.filter((s) => s.concurrent).map((s) => s.budgetMs));
}

const ENTRY = '~/.claude/scripts/hooks/claude-hook.mjs';
const PULL = '~/.claude/scripts/hooks/sync-hook.js --pull';

/**
 * The settings command for `event` (the template carries it verbatim; a test checks): a POSIX sh
 * line, as every hook command is (`~` paths). The synced settings reach every workstation at
 * once, ahead of a checkout that has this entry; a bare `claude` there pulls nothing, the pull
 * being one of the entry's own steps. So when the entry is absent, SessionStart first runs the
 * pull every older checkout has, then the entry; still absent, it says why and how to get it
 * (exit 0: never block a session). Every other event then exits 0 silently: a missing entry
 * never blocks a tool call or a notification. With the entry present, it
 * is `exec node <entry>`: one node process. The entry path is the command's first `~` token,
 * so doctor's hook-missing check reads it.
 */
export function hookCommand(event) {
  const missing = event !== 'SessionStart' ? 'exit 0' : `{ node ${PULL} </dev/null >/dev/null 2>&1; [ -f ${ENTRY} ] || { ` +
    `if git -C ~/.claude/scripts cat-file -e '@{u}:scripts/hooks/claude-hook.mjs' 2>/dev/null; ` +
    `then w='the pull did not fast-forward this checkout'; else w='its upstream does not carry it yet (offline, or main not yet promoted)'; fi; ` +
    `printf '{"systemMessage":"[claude-hook] SessionStart hooks skipped: claude-hook.mjs is absent and %s. Launch via ccc, or run: node ${PULL}"}\\n' "$w"; exit 0; }; }`;
  return `[ -f ${ENTRY} ] || ${missing}; exec node ${ENTRY} --event ${event}`;
}

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

/** Exit code 2 is a hook's block (Claude Code shows its stderr), never a failure. */
const BLOCK = 2;

/** One step's outcome as a notice, or null when it ended cleanly or blocked. */
export function failureOf(step, { code, timedOut, error }) {
  if (timedOut) return `${step.script} timed out after ${step.budgetMs / 1000}s`;
  if (error) return `${step.script} failed: ${error}`;
  if (code && code !== BLOCK) return `${step.script} exited ${code}`;
  return null;
}

const parseOutput = (out) => {
  const text = String(out ?? '').trim();
  if (!text) return { text };
  try { const o = JSON.parse(text); return o && typeof o === 'object' && !Array.isArray(o) ? { o } : { text }; } catch { return { text }; }
};

// A permission decision: the strictest step decides, as Claude Code resolves several hooks.
const DECISION_RANK = { allow: 1, ask: 2, deny: 3 };

/** Merge the stdout of several hook scripts and the notices of the failed ones into one hook output. */
export function mergeOutputs(results, event) {
  const merged = {}, messages = [], contexts = [];
  let decision = null;
  for (const { step, out, failure } of results) {
    const { o, text } = parseOutput(out);
    if (o) {
      const { systemMessage, hookSpecificOutput: h, ...rest } = o;
      Object.assign(merged, rest);
      if (systemMessage) messages.push(systemMessage);
      if (h?.additionalContext) contexts.push(h.additionalContext);
      if (h?.permissionDecision && (DECISION_RANK[h.permissionDecision] ?? 0) > (DECISION_RANK[decision?.permissionDecision] ?? 0)) {
        decision = { permissionDecision: h.permissionDecision,
          ...(h.permissionDecisionReason ? { permissionDecisionReason: h.permissionDecisionReason } : {}),
          ...(h.updatedInput ? { updatedInput: h.updatedInput } : {}) };
      }
    } else if (text) messages.push(`[${step.script}] ${text}`);
    if (failure) messages.push(`[claude-hook] ${event}: ${failure}`);
  }
  if (messages.length) merged.systemMessage = messages.join('\n');
  if (contexts.length || decision) {
    merged.hookSpecificOutput = { hookEventName: event, ...(contexts.length ? { additionalContext: contexts.join('\n') } : {}), ...decision };
  }
  return merged;
}

/** True when a step's output denies the call: the steps after it do not run. */
const denies = (out) => parseOutput(out).o?.hookSpecificOutput?.permissionDecision === 'deny';

const blocks = (r) => r.code === BLOCK && !r.timedOut && !r.error;

/**
 * Run `steps`, each isolated and within its own budget: the `concurrent` ones start at once
 * beside the rest (a side effect nothing waits on, as an `async` hook was), the others in order.
 * -> {output: the merged hook output (table order), blocked: the stderr of a step that exited 2, else null}.
 * A deny or a block ends the ordered run: the call will not happen, so no later ordered step (a
 * question waiting minutes for its answer) is spent on it.
 */
export async function runSteps(steps, raw, event, { run = runStep } = {}) {
  const started = new Map(steps.filter((s) => s.concurrent).map((s) => [s, run(s, raw)]));
  const outcomes = new Map();
  for (const step of steps) {
    if (step.concurrent) continue;
    const r = await run(step, raw);
    outcomes.set(step, r);
    if (blocks(r) || denies(r.out)) break;
  }
  for (const [step, pending] of started) outcomes.set(step, await pending);
  const done = steps.filter((s) => outcomes.has(s)).map((step) => ({ step, r: outcomes.get(step) }));
  const block = done.find(({ r }) => blocks(r));
  if (block) return { output: {}, blocked: block.r.err || `${block.step.script} blocked\n` };
  for (const { r } of done) if (r.err) process.stderr.write(r.err);
  return { output: mergeOutputs(done.map(({ step, r }) => ({ step, out: r.out, failure: failureOf(step, r) })), event), blocked: null };
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
  const { output, blocked } = await runSteps(stepsFor(event, lane, payload), raw, event);
  if (blocked !== null) {   // a step's block is the entry's: its stderr, exit 2
    await new Promise((done) => process.stderr.write(blocked, done));
    return BLOCK;
  }
  // Flushed before exit: stdout may be an asynchronous pipe.
  if (lane === 'foreground' && Object.keys(output).length) await new Promise((done) => process.stdout.write(JSON.stringify(output), done));
  return 0;
}

// Exit once done: a terminated or lingering step must not hold the hook open.
if (isMain(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`[claude-hook] ${e.message}\n`); return 0; }).then((code) => process.exit(code ?? 0));
}
