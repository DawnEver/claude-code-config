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
//   -> answer), and for a shell or an agent its task: started, ended, or left in the background;
//   Notification -> waiting-approval | waiting-input (with its message) | idle.
// SessionEnd is not mirrored: it also fires on in-process /clear and /resume, and the end of
// the process is already observed by the daemon as its channel's socket closing.
// After /clear or /resume the adapter does not know the new id yet: a prompt, final or answer
// it could not route is retried naming this hook's claude process, and the adapter learns the
// id from that, so activity and questions route by id again.
// A prompt, final or answer the daemon did not take (down, restarting, slow) is spooled and
// resent ahead of the next successful call, so a daemon hiccup delays rather than loses it;
// it carries its claude process, since a restarted daemon has forgotten the ids it learned.
// A session Claude Code gives no channel (ccds, or no flag) has its Telegram messages queued
// by the daemon; the Stop call gets them back and blocks the stop with them, so the session
// continues with those messages as its next turn.
// Every call carries the session's `transcriptPath`: when agent view relaunches a conversation
// under a new id, Claude Code appends a `continued-in` record there, and the adapter reads it.
// PreToolUse(AskUserQuestion) is a `question` call instead: in a turn started from Telegram
// the daemon holds it open until the answer is tapped there (up to QUESTION_TIMEOUT_MS), and
// the hook prints it as the tool's `answers`, so the terminal dialog never shows.
//
// Fail-open and silent: hook stdout can inject context, so only answers and deliveries print;
// every failure exits 0 (the dialog then shows locally); a hard timer bounds the run. A no-op
// unless the daemon's runtime file exists.

import fs from 'fs';
import net from 'net';
import path from 'path';
import { isMain } from '../shared/is-main.mjs';
import { RUNTIME_FILE } from '../bridge/context.mjs';
import { nearestClaude, processTable } from '../shared/process-tree.mjs';

const TIMEOUT_MS = 2000;   // per daemon call, and for the process-table lookup
// Hard exit: spool replay + call + process lookup + retry. The settings hook timeout exceeds it.
const RUN_MS = 4 * TIMEOUT_MS + 500;
const QUESTION_TIMEOUT_MS = 10 * 60000;   // the settings hook timeout must exceed this
const SPOOL_FILE = path.join(path.dirname(RUNTIME_FILE), 'spool.jsonl');
const SPOOL_TTL_MS = 60 * 60000;
const SPOOL_MAX = 100;   // newest kept; a daemon down for long should not flood the Topic
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

/** Assistant text blocks after the last real user message of a JSONL transcript. */
export function turnTexts(jsonl) {
  const entries = [];
  for (const l of String(jsonl).split('\n')) {
    if (!l.trim()) continue;
    try { entries.push(JSON.parse(l)); } catch { /* partial line */ }
  }
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
 * The background tasks this transcript started and has not yet seen end, each by the tool call
 * that started it (its PreToolUse `tool_use_id`, how the adapter knows the task). Claude Code
 * wakes the session when one ends and that turn's Stop reports again, so the list corrects
 * itself. Tasks do not outlive their claude process, so a start older than `maxAgeMs` (a
 * resumed session's old shells) no longer counts.
 */
export function backgroundTasks(jsonl, { now = Date.now(), maxAgeMs = 24 * 3600000 } = {}) {
  const open = new Map();   // task id -> the tool call that started it
  for (const l of String(jsonl).split('\n')) {
    if (!l.trim()) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const fresh = !(now - Date.parse(e.timestamp) > maxAgeMs);
    for (const [t, toolUseId] of taskTexts(e)) {
      const s = TASK_STARTED.exec(t);
      if (s && fresh) open.set(s[1] ?? s[2], toolUseId ?? s[1] ?? s[2]);
      const d = TASK_ENDED.exec(t);
      if (d) open.delete(d[1] ?? d[2]);
    }
  }
  return [...open.values()];
}

// The tools whose calls are tasks (tasks.mjs), by kind: a Bash or PowerShell shell, a monitor,
// and an agent (`Task` is its older name).
const TASK_TOOLS = { Bash: 'shell', PowerShell: 'powershell', Monitor: 'monitor', Agent: 'agent', Task: 'agent' };
// How long a monitor watches when its call says nothing, and at most (Claude Code's own limits).
const MONITOR_DEFAULT_MS = 300000, MONITOR_MAX_MS = 1800000;

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
    case 'PostToolUse': return background ? null : { op: 'end', id, status: 'completed' };
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
    let texts = [];
    if (payload.transcript_path) try { texts = turnTexts(fs.readFileSync(payload.transcript_path, 'utf8')); } catch { /* none */ }
    const last = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
    if (last && texts.at(-1) !== last) texts.push(last);
    let background = [];
    if (payload.transcript_path) try { background = backgroundTasks(fs.readFileSync(payload.transcript_path, 'utf8')); } catch { /* none */ }
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
    const task = taskFor(payload);
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

/** PreToolUse output that answers AskUserQuestion without showing its dialog. */
export function answerOutput(toolInput, answers) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } } };
}

/** Stop output that continues the session with queued Telegram messages, or null. */
export function deliverOutput(deliver) {
  if (!Array.isArray(deliver) || !deliver.length) return null;
  const msgs = deliver.map((d) => `${TELEGRAM_MESSAGE}${d?.user ? ` (${d.user})` : ''}:\n${String(d?.text ?? '')}`);
  return { decision: 'block', reason: msgs.join('\n\n') };
}

/** One authenticated call to the hub. Resolves its result, or null on any failure. */
export function callHub(method, params, { runtimeFile = RUNTIME_FILE, timeoutMs = TIMEOUT_MS } = {}) {
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
      try { done(JSON.parse(buf.slice(0, buf.indexOf('\n'))).result ?? null); } catch { done(null); }
    });
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

/** Keep a call the daemon did not take, for the next hook run to resend. */
export function spool(call, { file = SPOOL_FILE, now = Date.now() } = {}) {
  try { fs.appendFileSync(file, JSON.stringify({ at: now, call }) + '\n'); } catch { /* best effort */ }
}

/**
 * Resend spooled calls oldest first, within `budgetMs` so the hook's hard exit timer never
 * cuts a replay short; claimed by rename so concurrent hooks never double-send. The first
 * call the daemon does not take ends the replay: it and the rest go back to the spool.
 * Replays are marked so the adapter never hands them this session's queued Telegram
 * messages — only the live Stop hook can deliver those.
 */
export async function flushSpool({ file = SPOOL_FILE, now = Date.now, budgetMs = TIMEOUT_MS,
  send = (c, timeoutMs) => callHub('mirror', c, { timeoutMs }) } = {}) {
  const claimed = `${file}.${process.pid}`;
  try { fs.renameSync(file, claimed); } catch { return; }
  let lines = [];
  try { lines = fs.readFileSync(claimed, 'utf8').split('\n'); } catch { /* gone */ } finally { fs.rmSync(claimed, { force: true }); }
  const start = now();
  const entries = lines.flatMap((l) => { try { const e = JSON.parse(l); return e?.call ? [e] : []; } catch { return []; } })
    .filter((e) => start - e.at <= SPOOL_TTL_MS).slice(-SPOOL_MAX);
  for (let i = 0; i < entries.length; i++) {
    const left = budgetMs - (now() - start);
    if (left <= 0 || (await send({ ...entries[i].call, replay: true }, left)) === null) {
      for (const e of entries.slice(i)) spool(e.call, { file, now: e.at });
      return;
    }
  }
}

/** Content worth resending; pure state changes are superseded by the next hook anyway. */
const spoolable = (call) => call.kind !== 'activity' || Boolean(call.text);

/** This hook's claude process (it owns the channel), within the hook's time budget. */
const ownClaude = () => nearestClaude(process.ppid, processTable({ timeoutMs: TIMEOUT_MS }));

async function main() {
  // Most entries run async, so calls can reach the daemon out of order: the stamp orders them.
  const at = Date.now();
  if (!fs.existsSync(RUNTIME_FILE)) return;
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const payload = JSON.parse(raw || '{}');
  // Only the dedicated AskUserQuestion entry (long timeout) waits: Claude Code merges hook
  // entries with an identical command, so the catch-all one must not be that entry's twin.
  const question = process.argv.includes('--question') ? questionFor(payload) : null;
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const withTranscript = (c) => (c && transcriptPath ? { ...c, transcriptPath } : c);
  // A non-question run may spend one budget on a spool replay and one on its own call.
  setTimeout(() => process.exit(0), question ? QUESTION_TIMEOUT_MS + 500 : RUN_MS).unref();
  if (question) {
    const r = await callHub('question', withTranscript(question), { timeoutMs: QUESTION_TIMEOUT_MS });
    // Flushed before the process exits: stdout may be an asynchronous pipe.
    if (r?.answers && typeof r.answers === 'object') await new Promise((done) => process.stdout.write(JSON.stringify(answerOutput(payload.tool_input, r.answers)), done));
    return;
  }
  const mirror = withTranscript(mirrorFor(payload));
  if (!mirror) return;
  const call = { ...mirror, at };
  // No session matched: after /clear or /resume the id is new. Retry naming this hook's own
  // claude process (the one owning the channel). Looked up only now — a process-table query is
  // slow, so never for the per-tool activity calls — and never from CLAUDE_PID, which a nested
  // `claude` inherits from its parent.
  if (fs.existsSync(SPOOL_FILE)) await flushSpool();
  let r = await callHub('mirror', call);
  if (r === null && spoolable(call)) { spool({ ...call, claudePid: ownClaude() ?? undefined }); return; }
  if (r?.routed === false && call.kind !== 'activity') {
    const claudePid = ownClaude();
    if (claudePid) r = await callHub('mirror', { ...call, claudePid, retry: true });
  }
  const out = payload.hook_event_name === 'Stop' && deliverOutput(r?.deliver);
  if (out) await new Promise((done) => process.stdout.write(JSON.stringify(out), done));
}

if (isMain(import.meta.url)) main().catch(() => {}).finally(() => process.exit(0));
