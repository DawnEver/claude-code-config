#!/usr/bin/env node
// bridge-hook.js — mirror a Claude session's turns, state and questions to its Telegram Topic.
//
// The model is not trusted to call the channel's `reply` tool, so — like the Codex adapter
// does for Codex — the session is mirrored mechanically through one authenticated call to the
// bridge daemon's Claude adapter (claude-adapter.mjs; 127.0.0.1, port + token from
// runtime.json), naming the conversation id current in this claude process (payload.session_id):
//   UserPromptSubmit -> prompt;  Stop -> final (every text block of the turn; the adapter
//   drops blocks it already sent; with the background shells and agents still running, by
//   their tool call, so the adapter ends the others);  StopFailure -> failed final;
//   PreToolUse / PostToolUse / PostToolUseFailure -> activity running (PostToolUse(AskUserQuestion)
//   -> answer), and for a shell, a monitor or an agent its task: started, ended, or left in the
//   background;  Notification -> waiting-approval | waiting-input (with its message) | idle.
// Every tool event reaches it: PostToolUse / PostToolUseFailure for every tool, and Notification
// and PreToolUse (with AskUserQuestion's `--question` call) through claude-hook.mjs, which runs
// this script in a worker thread beside the loop guard.
// SessionEnd is not mirrored: it also fires on in-process /clear and /resume, and the end of
// the process is already observed by the daemon as its channel's socket closing.
// After /clear or /resume the adapter does not know the new id: that rename's SessionStart
// (`--learn`, see "The claude process of a renamed session") records this session's claude
// process once, and every call of the session names it, so the adapter learns the new id on its
// first call. No process-table query (1.8-3.2 s of PowerShell on Windows) runs on a prompt, stop
// or tool call, and CLAUDE_PID is never read (a nested claude inherits its parent's).
//
// EVERY HOOK < 5 s, FOR THE WHOLE EVENT (user ruling D24, 2026-11-17), AND THE MIRROR LOSES NOTHING:
// a hook makes at most ONE call, bounded by CALL_MS. A call the daemon did not take (down,
// restarting, hung) is appended to the spool and a detached sender (`--send-spool`, one at a time
// by its lease, started by ANY hook run that finds the spool pending) delivers the spool in order,
// retrying until the daemon is back; an entry leaves the spool only on the daemon's ack (see "The
// spool"); while a spool is pending a hook appends to it instead of calling, so order holds. Replays are marked, so the
// adapter never hands them this session's queued Telegram messages: only a live Stop call can.
// A session Claude Code gives no channel (ccds, or no flag) has its Telegram messages queued
// by the daemon; the Stop call gets them back and blocks the stop with them, so the session
// continues with those messages as its next turn (with a spool pending, at the next Stop).
// Every call carries the session's `transcriptPath`: when agent view relaunches a conversation
// under a new id, Claude Code appends a `continued-in` record there, and the adapter reads it.
// PreToolUse(AskUserQuestion) is a `question` call instead, answered at once: in a turn started
// from Telegram the daemon posts the question there and the hook DENIES the terminal dialog,
// telling the model to end its turn; the answer tapped on Telegram arrives as the next message.
// (It used to hold the call open up to ten minutes for the answer, which no 5 s hook can.)
//
// Fail-open and silent: hook stdout can inject context, so only question denials and deliveries
// print; every failure exits 0. A no-op unless the daemon's runtime file exists.

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { isMain } from '../shared/is-main.mjs';
import { acquireOwnerLock } from '../shared/owner-lock.mjs';
import { RUNTIME_FILE, SPOOL_NAMES } from '../bridge/runtime-paths.mjs';

/** The one daemon call a hook makes: a healthy daemon answers in milliseconds. */
export const CALL_MS = 1000;
// Hard exit: one call, the output flush and the sender start. The settings hook timeout (5 s) exceeds it.
const RUN_MS = CALL_MS + 1500;
const inRuntime = (name) => path.join(path.dirname(RUNTIME_FILE), SPOOL_NAMES[name]);
const SPOOL_FILE = inRuntime('spool');
const INFLIGHT_FILE = inRuntime('inflight');
const CURSOR_FILE = inRuntime('cursor');
const HELD_FILE = inRuntime('held');
const LEASE_FILE = inRuntime('lease');
const CLAUDE_PIDS_FILE = path.join(path.dirname(RUNTIME_FILE), 'claude-pids.json');
/** A sender renews its lease every loop; one older than this died. */
export const LEASE_STALE_MS = 30_000;
const SENDER_LIFETIME_MS = 10 * 60000;   // then any next hook that finds the spool pending starts another
const SENDER_LINGER_MS = 3000;           // an idle sender waits this long for the next call
const RETRY_MAX_MS = 5000;
// A hook that opened the spool just before the sender renamed it finishes its one-line append
// into the claimed file within microseconds; the sender reads the claimed file only after this.
const CLAIM_GRACE_MS = 500;
const COMPACT_EVERY = 200;               // acked entries before the in-flight file is rewritten
// The daemon's definite refusals (JSON-RPC invalid params, unknown method): retrying cannot help,
// so the entry is HELD (kept in spool.held.jsonl, counted by doctor). Every other answer -- none,
// a hang, unauthorized (a token rotating with a restart), a result without ok -- is no ack: retried.
const REFUSED = new Set([-32602, -32601]);
const NOTIFICATION_STATES = { permission_prompt: 'waiting-approval', elicitation_dialog: 'waiting-input', idle_prompt: 'idle' };

/** How a Telegram message delivered through the Stop hook begins (deliverOutput writes it). */
const TELEGRAM_MESSAGE = 'Message from Telegram';

/**
 * Where the text still to mirror begins: a message typed here, a message from Telegram by the
 * channel (an `isMeta` entry whose origin is the channel), or any Stop-hook continuation (a
 * Telegram message delivered through the Stop hook, or a plugin's feedback) — the Stop before it
 * already mirrored everything up to there. Missing those repeated the earlier answer before the new one.
 */
const isRealUser = (e) => {
  if (e?.type !== 'user') return false;
  const c = e.message?.content;
  if (e.isMeta) return e.origin?.kind === 'channel' || (typeof c === 'string' && c.startsWith('Stop hook feedback:'));
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b?.type === 'text');
};

/** The entries of a JSONL transcript; a partial line is skipped. */
export function parseJsonl(jsonl) {
  const entries = [];
  for (const l of String(jsonl).split('\n')) {
    if (!l.trim()) continue;
    try { entries.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return entries;
}

const entriesOf = (t) => (Array.isArray(t) ? t : parseJsonl(t));

/** Assistant text blocks after the last real user message of a transcript (JSONL, or its entries). */
export function turnTexts(transcript) {
  const entries = entriesOf(transcript);
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isRealUser(entries[i])) { start = i + 1; break; }
  const texts = [];
  for (const e of entries.slice(start)) {
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) if (b?.type === 'text' && b.text?.trim()) texts.push(b.text.trim());
  }
  return texts;
}

// What Claude Code writes when it starts a background task (a shell, an agent) and
// when one ends (a task notification, or TaskStop's result: a stopped task gets none), each
// at the start of a tool result or a notification. Anchored there: any other tool's output,
// a grep of a transcript say, may contain the same words. A Monitor is not counted: it
// watches rather than works, and it expires without a closing notification.
const TASK_STARTED = /^(?:Command running in background with ID: ([A-Za-z0-9]+)|Async agent launched[\s\S]{0,400}?agentId: ([A-Za-z0-9]+))/;
const TASK_ENDED = /^(?:<task-notification>\s*<task-id>([A-Za-z0-9]+)<\/task-id>[\s\S]*?<status>(?:completed|failed|killed|stopped)<\/status>|\{"message":"Successfully stopped task: ([A-Za-z0-9]+))/;

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('') : '');

/** The texts of a transcript entry that can carry a task's start or end, each with its tool call if a tool result. */
function taskTexts(e) {
  if (e?.type === 'attachment') return [[textOf(e.attachment?.prompt)]];
  if (e?.type === 'queue-operation') return [[textOf(e.content)]];
  if (e?.type !== 'user') return [];
  const c = e.message?.content;
  if (!Array.isArray(c)) return [[textOf(c)]];
  return c.map((b) => (b?.type === 'tool_result' ? [textOf(b.content), b.tool_use_id] : [textOf([b])]));
}

/**
 * The background tasks this transcript started and has not yet seen end, each as its call made
 * it — `{id, kind, label, startedAt}`, `id` the tool call that started it (its PreToolUse
 * `tool_use_id`, how the adapter knows the task) — so the adapter can take them as the truth:
 * end any other, and add one it lost (a daemon restart forgets them all). Claude Code wakes the
 * session when one ends and that turn's Stop reports again, so the list corrects itself. Tasks
 * do not outlive their claude process, so a start older than `maxAgeMs` (a resumed session's
 * old shells) no longer counts.
 */
export function backgroundTasks(transcript, { now = Date.now(), maxAgeMs = 24 * 3600000 } = {}) {
  const calls = new Map();   // tool call id -> {kind, label, at} of a task tool's call
  const open = new Map();    // task id -> its task, keyed so its end finds it
  for (const e of entriesOf(transcript)) {
    const at = Date.parse(e.timestamp);
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        const kind = b?.type === 'tool_use' && TASK_TOOLS[b.name];
        if (kind) calls.set(b.id, { kind, label: taskLabel(kind, b.input), at });
      }
    }
    const fresh = !(now - at > maxAgeMs);
    for (const [t, toolUseId] of taskTexts(e)) {
      const s = TASK_STARTED.exec(t);
      if (s && fresh) {
        const id = toolUseId ?? s[1] ?? s[2];
        const call = calls.get(id);
        open.set(s[1] ?? s[2], { id, kind: call?.kind ?? (s[2] ? 'agent' : 'shell'), label: call?.label ?? '', startedAt: call?.at ?? at });
      }
      const d = TASK_ENDED.exec(t);
      if (d) open.delete(d[1] ?? d[2]);
    }
  }
  return [...open.values()];
}

// The line a task-starting tool result begins with, naming the task id TaskStop takes: a
// monitor's, a background shell's, an agent's.
const TASK_ID_STARTED = /^(?:Monitor started \(task ([A-Za-z0-9]+)|Command running in background with ID: ([A-Za-z0-9]+)|Async agent launched[\s\S]{0,400}?agentId: ([A-Za-z0-9]+))/;

/**
 * The tool call (its `tool_use_id`, the adapter's task id) whose result started task `taskId`,
 * or null. A TaskStop names the task, not the call: this joins the two, so a monitor stopped
 * early ends now rather than at its deadline.
 */
export function taskCallOf(transcript, taskId) {
  for (const e of entriesOf(transcript)) {
    for (const [t, toolUseId] of taskTexts(e)) {
      if (!toolUseId) continue;
      const m = TASK_ID_STARTED.exec(t);
      if (m && (m[1] ?? m[2] ?? m[3]) === taskId) return toolUseId;
    }
  }
  return null;
}

/** The end a returned TaskStop reports for the task it stopped, or null. */
function stoppedTask(payload) {
  const taskId = payload.tool_input?.task_id ?? payload.tool_input?.shell_id;
  if (typeof taskId !== 'string' || !taskId || typeof payload.transcript_path !== 'string') return null;
  let id = null;
  try { id = taskCallOf(fs.readFileSync(payload.transcript_path, 'utf8'), taskId); } catch { /* none */ }
  return id ? { op: 'end', id, status: 'stopped' } : null;
}

// The tools whose calls are tasks (activity-board.mjs), by kind: a Bash or PowerShell shell, a monitor,
// and an agent (`Task` is its older name).
const TASK_TOOLS = { Bash: 'shell', PowerShell: 'powershell', Monitor: 'monitor', Agent: 'agent', Task: 'agent' };
// How long a monitor watches when its call says nothing, and at most (Claude Code's own limits).
const MONITOR_DEFAULT_MS = 300000, MONITOR_MAX_MS = 1800000;

// A tool response saying the call went on in the background (its text, or the shell's field).
const WENT_BACKGROUND = /Async agent launched|Command running in background with ID|"backgroundTaskId":"/;
const responseText = (r) => (typeof r === 'string' ? r : JSON.stringify(r ?? ''));

/** What a tool call is, as a task: what it says it does, else its command (a monitor: its socket); an agent's type and description. */
function taskLabel(kind, input = {}) {
  if (kind === 'agent') return [input.subagent_type, input.description].filter(Boolean).join(': ');
  return String(input.description || input.command || input.ws?.url || '');
}

/**
 * The task a PreToolUse / PostToolUse / PostToolUseFailure of a shell, a monitor or an agent
 * reports, or null: started; ended (completed or failed); or, run in the background, still
 * running — a shell's or an agent's end is read from the transcript at a later Stop
 * (backgroundTasks); a monitor always watches in the background, until it expires (`timeoutMs`).
 */
export function taskFor(payload) {
  const kind = TASK_TOOLS[payload?.tool_name];
  const id = payload?.tool_use_id;
  if (!kind || typeof id !== 'string') return null;
  const input = payload.tool_input ?? {};
  const background = kind === 'monitor' || input.run_in_background === true;
  const monitor = kind === 'monitor' ? { timeoutMs: Math.min(Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : MONITOR_DEFAULT_MS, MONITOR_MAX_MS) } : {};
  switch (payload.hook_event_name) {
    case 'PreToolUse': return { op: 'start', id, kind, label: taskLabel(kind, input), background, ...monitor };
    // Returned: done, unless it went to the background — asked to, or by itself (Claude Code moves
    // a long shell or an agent there unasked): then it runs on, and a later Stop reads its end.
    case 'PostToolUse': return background ? null : WENT_BACKGROUND.test(responseText(payload.tool_response)) ? { op: 'background', id } : { op: 'end', id, status: 'completed' };
    case 'PostToolUseFailure': return { op: 'end', id, status: payload.is_interrupt ? 'stopped' : 'failed' };
    default: return null;
  }
}

/** `Q -> A` lines of an answered AskUserQuestion, from its tool response or input. */
export function answerText(payload) {
  const answers = payload.tool_response?.answers ?? payload.tool_input?.answers;
  if (!answers || typeof answers !== 'object') return '';
  return Object.entries(answers).map(([q, a]) => `${q} -> ${[].concat(a).join(', ')}`).join('\n');
}

/** The mirror call for one hook payload, or null when there is nothing to send. */
export function mirrorFor(payload) {
  const sessionId = payload?.session_id;
  if (!sessionId) return null;
  const base = { sessionId };
  if (payload?.hook_event_name === 'UserPromptSubmit') {
    const text = String(payload.prompt ?? '');
    // A channel prompt (from Telegram) is sent too: the daemon's echo suppression drops it.
    if (!text.trim()) return null;
    return { ...base, kind: 'prompt', text };
  }
  if (payload?.hook_event_name === 'Stop') {
    // The transcript may lag the last message; last_assistant_message never does.
    // Read and parsed once: a long session's transcript runs to tens of MB, and Stop is sync.
    let entries = [];
    if (payload.transcript_path) try { entries = parseJsonl(fs.readFileSync(payload.transcript_path, 'utf8')); } catch { /* none */ }
    const texts = turnTexts(entries);
    const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
    if (last && texts.at(-1) !== last) texts.push(last);
    const background = backgroundTasks(entries);
    // A turn with no text still ends: idle, and its background tasks (none ends every other).
    return { ...base, kind: 'final', texts, background };
  }
  // A turn ended by an API error fires StopFailure instead of Stop; it waits for the human.
  if (payload?.hook_event_name === 'StopFailure') {
    const text = [payload.error_type ?? 'unknown', payload.error_message].filter(Boolean).join(': ');
    return { ...base, kind: 'final', status: 'failed', text };
  }
  const event = payload?.hook_event_name;
  if (event === 'PostToolUse' && payload.tool_name === 'AskUserQuestion') return { ...base, kind: 'answer', text: answerText(payload) };
  if ((event === 'PreToolUse' && payload.tool_name !== 'AskUserQuestion') || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const task = event === 'PostToolUse' && payload.tool_name === 'TaskStop' ? stoppedTask(payload) : taskFor(payload);
    return { ...base, kind: 'activity', state: 'running', ...(task ? { task } : {}) };
  }
  if (event === 'Notification') {
    const state = NOTIFICATION_STATES[payload.notification_type];
    if (!state) return null;
    // What it waits for ("Claude needs your permission to use Bash") is worth a message.
    const text = state !== 'idle' && typeof payload.message === 'string' ? payload.message.trim() : '';
    return { ...base, kind: 'activity', state, ...(text ? { text } : {}) };
  }
  return null;
}

/** The `question` call for a PreToolUse(AskUserQuestion) payload, or null. */
export function questionFor(payload) {
  if (payload?.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'AskUserQuestion') return null;
  const questions = payload.tool_input?.questions;
  const sessionId = payload.session_id;
  return Array.isArray(questions) && questions.length && sessionId ? { sessionId, questions, wait: true } : null;
}


const QUESTION_POSTED = 'This turn came from Telegram, so the question was posted to the user\'s Telegram Topic instead of the terminal. '
  + 'Do not ask it again: end your turn now. The user\'s answer arrives as the next message.';

/**
 * PreToolUse output for a question the daemon took: posted to Telegram (a turn started there),
 * the terminal dialog is denied and the answer comes as the next message. Otherwise null: the
 * terminal dialog shows (a locally typed turn, or no bridge).
 */
export function questionOutput(r) {
  if (!r?.posted) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: QUESTION_POSTED } };
}

/** Stop output that continues the session with queued Telegram messages, or null. */
export function deliverOutput(deliver) {
  if (!Array.isArray(deliver) || !deliver.length) return null;
  const msgs = deliver.map((d) => `${TELEGRAM_MESSAGE}${d?.user ? ` (${d.user})` : ''}:\n${String(d?.text ?? '')}`);
  return { decision: 'block', reason: msgs.join('\n\n') };
}

// ── The claude process of a renamed session ──
// /clear and /resume give a session a new id its channel never registered. Its claude process is
// found by walking this hook's own ancestry (so a nested claude finds itself, never its parent),
// which takes a process-table query: 1.2-3.9 s of PowerShell on Windows -- more than a 5 s
// SessionStart can carry beside its other steps (user ruling D24). So ONE detached learner
// (`--learner`, one at a time by LEARN_LOCK, which names its owner) answers every renamed
// session's request and records the result in claude-pids.json (atomically); every later call of
// the session names it. The SessionStart step (`--learn`) only files the request and keeps this
// process -- and so the shell between it and claude -- alive until the learner's snapshot holds
// them (its `.snap` marker), for at most LEARN_WAIT_MS. Until the result lands (seconds), the
// session's prompts and finals are held by the adapter and released by the first call that names
// the process. A snapshot later than LEARN_WAIT_MS no longer sees the shell: that rename stays
// unrouted (its calls held, then dropped after 30 s, with a warning) until its next SessionStart.

/** How long the SessionStart step waits for the learner's snapshot (claude-hook gives the step 3.5 s). */
export const LEARN_WAIT_MS = 3000;
const LEARN_DIR = path.join(path.dirname(RUNTIME_FILE), 'learn');
const LEARN_LOCK = path.join(path.dirname(RUNTIME_FILE), 'learn.lock');
const LEARN_QUERY_MS = 15000;
const LEARNER_LINGER_MS = 1000;
const CLAUDE_PIDS_MAX = 200;

const requestFileOf = (dir, sessionId) => path.join(dir, `${createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 16)}.json`);
const spawnLearner = () => spawn(process.execPath, [fileURLToPath(import.meta.url), '--learner'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();

/**
 * File this session's request (its id and the pid its ancestry walk starts from) and start the
 * learner unless a live one holds the lock -- held for it, by this hook, until it takes it over.
 * Returns the request file, or null without a session.
 */
export function requestLearn(payload, { dir = LEARN_DIR, lock = LEARN_LOCK, from = process.ppid, now = Date.now(), start = spawnLearner } = {}) {
  const sessionId = payload?.session_id;
  if (!sessionId) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = requestFileOf(dir, sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessionId, from, at: now }));
  fs.renameSync(tmp, file);
  const release = acquireOwnerLock(lock, { now });
  if (release) { try { start(); } catch { release(); } }
  return file;
}

/** The SessionStart step: request, then wait (at most `waitMs`) for the learner's snapshot or answer. */
export async function learnStep(payload, { waitMs = LEARN_WAIT_MS, pids = CLAUDE_PIDS_FILE, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
  if (!payload?.session_id || claudePidOf(payload.session_id, { file: pids })) return;
  const file = requestLearn(payload, opts);
  if (!file) return;
  for (const end = Date.now() + waitMs; Date.now() < end && fs.existsSync(file) && !fs.existsSync(`${file}.snap`);) await sleep(50);
}

/**
 * THE LEARNER: take the lock over from the hook that started it, then answer every queued request
 * from one snapshot per round -- each request's `.snap` marker written the moment the snapshot is
 * taken, its claude process recorded after the walk -- until none is left for `lingerMs`.
 */
export async function runLearner({ dir = LEARN_DIR, lock = LEARN_LOCK, pids = CLAUDE_PIDS_FILE, tableAsync, lingerMs = LEARNER_LINGER_MS,
  queryMs = LEARN_QUERY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const tree = await import('../shared/process-tree.mjs');
  const query = tableAsync ?? tree.processTableAsync;
  const pending = () => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { /* none */ }
    return names.flatMap((n) => {
      const file = path.join(dir, n);
      try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r?.sessionId ? [{ ...r, file }] : []; } catch { return []; }
    });
  };
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));   // handed over by the requesting hook
  // A hook that filed a request just as this learner let go saw a live owner and started none:
  // look again after letting go, and carry on while a request waits.
  do {
    try {
      for (let idleSince = Date.now(); ;) {
        const requests = pending();
        if (!requests.length) {
          if (Date.now() - idleSince >= lingerMs) break;
          await sleep(100);
          continue;
        }
        const table = await query({ timeoutMs: queryMs, onSnapshot: () => { for (const r of requests) try { fs.writeFileSync(`${r.file}.snap`, ''); } catch { /* the step stops waiting anyway */ } } });
        for (const r of requests) {
          const pid = tree.nearestClaude(Number(r.from), table);
          if (pid) rememberClaude(r.sessionId, pid, { file: pids });
          fs.rmSync(r.file, { force: true });
          fs.rmSync(`${r.file}.snap`, { force: true });
        }
        idleSince = Date.now();
      }
    } finally {
      try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
    }
  } while (pending().length && acquireOwnerLock(lock));
}

/** The claude process recorded for `sessionId`, or undefined. A torn or foreign file reads as none. */
export function claudePidOf(sessionId, { file = CLAUDE_PIDS_FILE } = {}) {
  try { return Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.[sessionId]?.pid) || undefined; } catch { return undefined; }
}

/** Record `sessionId` -> `pid` (atomically; the newest CLAUDE_PIDS_MAX kept). */
export function rememberClaude(sessionId, pid, { file = CLAUDE_PIDS_FILE, now = Date.now() } = {}) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* none yet, or torn */ }
  all[sessionId] = { pid, at: now };
  const kept = Object.fromEntries(Object.entries(all).filter(([, v]) => Number(v?.pid)).sort((a, b) => b[1].at - a[1].at).slice(0, CLAUDE_PIDS_MAX));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(kept));
  fs.renameSync(tmp, file);
}

/**
 * One authenticated call to the hub. Resolves its result; `{ error }` when the daemon answered
 * with an error; null when it did not answer (down, hung, a torn reply).
 */
export function callHub(method, params, { runtimeFile = RUNTIME_FILE, timeoutMs = CALL_MS } = {}) {
  let rt;
  try { rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { return Promise.resolve(null); }
  if (!Number.isInteger(rt?.port) || typeof rt.token !== 'string') return Promise.resolve(null);
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: rt.port });
    const done = (v) => { clearTimeout(timer); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { token: rt.token, ...params } }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      try {
        const msg = JSON.parse(buf.slice(0, buf.indexOf('\n')));
        done(msg.error ? { error: msg.error } : msg.result ?? null);
      } catch { done(null); }
    });
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

// ── The spool ──
// THE MIRROR LOSES NOTHING (standing user ruling): DELIVERY IS THE ONLY WAY AN ENTRY LEAVES. There is
// no age or count eviction; an entry leaves the spool only once the daemon ACKED it (`ok: true`); one
// the daemon refuses, and a torn line, go to the held file -- kept, and counted by doctor.
// Hooks append (one write per call, O_APPEND); only the lease holder (the sender) moves lines out:
// it claims the spool by rename into its in-flight file (merging any claim a dead sender left),
// sends from the cursor, and advances the cursor on each ack. The acked prefix is compacted away
// every COMPACT_EVERY acks and when the file is done -- the cursor reset BEFORE the rewrite, so a
// crash between the two re-sends acked entries (the daemon drops a final it already sent) and
// never skips an unacked one. A hook sees a pending spool when the spool or in-flight file exists.

/** Keep a call the daemon did not take, for the sender to deliver. */
export function spool(call, { file = SPOOL_FILE, now = Date.now() } = {}) {
  try { fs.appendFileSync(file, JSON.stringify({ at: now, call }) + '\n'); } catch { /* best effort */ }
}

/** A spool file's lines: its entries oldest first, and the raw lines that are not one (torn or foreign). */
function splitSpool(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { entries: [], torn: [] }; }
  const entries = [], torn = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const e = JSON.parse(l); if (e?.call) entries.push(e); else torn.push(l); } catch { torn.push(l); }
  }
  return { entries, torn };
}

/** The entries of a spool file, oldest first (a torn line is not an entry; the sender holds it). */
export const readSpool = (file) => splitSpool(file).entries;

const writeLines = (file, entries) => {
  if (!entries.length) { fs.rmSync(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, file);
};

const hold = (held, lines) => { if (lines.length) fs.appendFileSync(held, lines.join('\n') + '\n'); };
const readCursor = (cursor) => { try { return Math.max(0, Number.parseInt(fs.readFileSync(cursor, 'utf8'), 10) || 0); } catch { return 0; } };
const writeCursor = (cursor, n) => { const tmp = `${cursor}.${process.pid}.tmp`; fs.writeFileSync(tmp, String(n)); fs.renameSync(tmp, cursor); };

/**
 * Move the hooks' spool, and any claim a dead sender left (`<spool>.<pid>`), behind the in-flight
 * file; torn lines go to the held file. False when the spool could not be claimed now.
 */
async function claimSpool(file, inflight, held, graceMs, sleep) {
  const dir = path.dirname(file), base = path.basename(file);
  const orphans = () => { try { return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n.slice(base.length + 1)) && n.startsWith(`${base}.`)).sort(); } catch { return []; } };
  let claimedNow = false;
  if (fs.existsSync(file)) {
    try { fs.renameSync(file, `${file}.${process.pid}`); claimedNow = true; } catch { /* a hook holds it: next loop */ }
  }
  const claims = orphans();
  if (!claims.length) return !fs.existsSync(file);
  if (claimedNow && graceMs) await sleep(graceMs);   // a hook mid-append finishes into the claimed file
  const merged = readSpool(inflight);
  for (const n of claims) {
    const { entries, torn } = splitSpool(path.join(dir, n));
    merged.push(...entries);
    hold(held, torn);
  }
  writeLines(inflight, merged);   // the acked prefix is unchanged, so the cursor still holds
  for (const n of claims) fs.rmSync(path.join(dir, n), { force: true });
  return true;
}

function takeLease(lease, now = Date.now()) {
  try { fs.writeFileSync(lease, String(process.pid), { flag: 'wx' }); return true; } catch { /* held */ }
  try {
    if (now - fs.statSync(lease).mtimeMs < LEASE_STALE_MS) return false;
    fs.rmSync(lease, { force: true });
    fs.writeFileSync(lease, String(process.pid), { flag: 'wx' });
    return true;
  } catch { return false; }
}

const renew = (lease) => { try { const t = new Date(); fs.utimesSync(lease, t, t); } catch { /* gone: the loop ends */ } };

/** What a daemon answer means for a spooled entry: acked, refused for good, or not taken (retry). */
export function outcomeOf(r) {
  if (r?.ok === true) return 'acked';
  return REFUSED.has(r?.error?.code) ? 'refused' : 'retry';
}

/**
 * THE SENDER: deliver the spool in order, each call marked as a replay. An entry leaves only on
 * the daemon's ack; a refusal holds it; anything else is retried (backoff up to RETRY_MAX_MS) until
 * `lifetimeMs`, after which it stays for the next sender (any hook that finds the spool pending
 * starts one). Idle for `lingerMs`, it ends. One at a time, by `lease`.
 */
export async function sendSpool({ file = SPOOL_FILE, inflight = INFLIGHT_FILE, cursor = CURSOR_FILE, held = HELD_FILE, lease = LEASE_FILE,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), lifetimeMs = SENDER_LIFETIME_MS, lingerMs = SENDER_LINGER_MS,
  claimGraceMs = CLAIM_GRACE_MS, send = (c) => callHub('mirror', c), runtimeFile = RUNTIME_FILE } = {}) {
  const start = now();
  // A hook that appended just as this sender let its lease go saw the lease still fresh and
  // started none: look again after letting go, and carry on while the spool has a line.
  while (now() - start < lifetimeMs && fs.existsSync(runtimeFile) && takeLease(lease)) {
    let idleSince = now(), backoff = 500;
    try {
      let entries = [], next = 0, acked = 0;
      const compact = () => {
        if (next === 0) return;
        writeCursor(cursor, 0);                      // first: a crash now re-sends, never skips
        writeLines(inflight, entries.slice(next));
        entries = entries.slice(next); next = 0; acked = 0;
      };
      const load = () => { entries = readSpool(inflight); next = Math.min(readCursor(cursor), entries.length); acked = 0; };
      load();
      while (now() - start < lifetimeMs) {
        renew(lease);
        if (next >= entries.length) {
          compact();
          if (await claimSpool(file, inflight, held, claimGraceMs, sleep)) load();
          if (next >= entries.length) {
            if (!fs.existsSync(file) && now() - idleSince >= lingerMs) break;
            await sleep(200);
            continue;
          }
        }
        if (!fs.existsSync(runtimeFile)) break;   // the bridge is uninstalled: the spool waits
        const e = entries[next];
        const outcome = outcomeOf(await send({ ...e.call, replay: true }));
        if (outcome === 'retry') { await sleep(backoff); backoff = Math.min(backoff * 2, RETRY_MAX_MS); continue; }
        if (outcome === 'refused') hold(held, [JSON.stringify(e)]);   // kept before it is passed
        backoff = 500;
        idleSince = now();
        writeCursor(cursor, ++next);
        if (++acked >= COMPACT_EVERY) compact();
      }
      if (next >= entries.length && entries.length) compact();
    } finally {
      fs.rmSync(lease, { force: true });
    }
    if (!fs.existsSync(file)) return;
  }
}

/** Start the detached sender unless one holds a fresh lease. True when one was started. */
export function startSender({ lease = LEASE_FILE, now = Date.now(), start = () => spawn(process.execPath,
  [fileURLToPath(import.meta.url), '--send-spool'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref() } = {}) {
  try { if (now - fs.statSync(lease).mtimeMs < LEASE_STALE_MS) return false; } catch { /* no sender */ }
  try { start(); return true; } catch { return false; }
}

const spoolPending = () => fs.existsSync(SPOOL_FILE) || fs.existsSync(INFLIGHT_FILE);

// Delivery never waits for a particular event: EVERY run of this hook (prompt, tool call, stop,
// notification, question, a rename's SessionStart) that finds the spool pending and no live sender
// starts the one detached sender. Two stats when nothing is pending.
let senderStarted = false;
const ensureSender = () => { if (!senderStarted && spoolPending()) senderStarted = startSender(); };

/** Content and task facts are worth delivering late; a bare state change is superseded by the next hook. */
const spoolable = (call) => call.kind !== 'activity' || Boolean(call.text) || Boolean(call.task);

async function main() {
  if (process.argv.includes('--send-spool')) { await sendSpool(); return; }
  if (process.argv.includes('--learner')) { await runLearner(); return; }
  // Most entries run async, so calls can reach the daemon out of order: the stamp orders them.
  const at = Date.now();
  if (!fs.existsSync(RUNTIME_FILE)) return;
  ensureSender();
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const payload = JSON.parse(raw || '{}');
  if (process.argv.includes('--learn')) {
    // A SessionStart of a rename: the background learner finds its claude process (see above).
    await learnStep(payload);
    return;
  }
  setTimeout(() => process.exit(0), RUN_MS).unref();
  const claudePid = payload.session_id ? claudePidOf(payload.session_id) : undefined;
  const route = { ...(typeof payload.transcript_path === 'string' && payload.transcript_path ? { transcriptPath: payload.transcript_path } : {}),
    ...(claudePid ? { claudePid } : {}) };
  // Only the dedicated AskUserQuestion step asks: Claude Code merges hook entries with an
  // identical command, so the catch-all mirror must not be that step's twin.
  const question = process.argv.includes('--question') ? questionFor(payload) : null;
  if (question) {
    const out = questionOutput(await callHub('question', { ...question, ...route }));
    // Flushed before the process exits: stdout may be an asynchronous pipe.
    if (out) await new Promise((done) => process.stdout.write(JSON.stringify(out), done));
    return;
  }
  const mirror = mirrorFor(payload);
  if (!mirror) return;
  const call = { ...mirror, ...route, at };
  // A pending spool goes first: this call joins it, so the daemon sees every call in order.
  const r = spoolPending() ? null : await callHub('mirror', call);
  const outcome = outcomeOf(r);
  if (outcome !== 'acked') {
    if (outcome === 'refused') hold(HELD_FILE, [JSON.stringify({ at, call })]);   // kept and counted, never dropped
    else if (spoolable(call)) spool(call);
    ensureSender();
    return;
  }
  const out = payload.hook_event_name === 'Stop' && deliverOutput(r?.deliver);
  if (out) await new Promise((done) => process.stdout.write(JSON.stringify(out), done));
}

if (isMain(import.meta.url)) main().catch(() => {}).finally(() => process.exit(0));
