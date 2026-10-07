#!/usr/bin/env node
// bridge-hook.js — mirror a Claude session's turns, state and questions to its Telegram Topic.
//
// The model is not trusted to call the channel's `reply` tool, so — like the Codex adapter
// does for Codex — the session is mirrored mechanically through one authenticated call to the
// bridge daemon's Claude adapter (claude-adapter.mjs; 127.0.0.1, port + token from
// runtime.json), naming the session by id so the adapter finds its registered channel:
//   UserPromptSubmit -> prompt;  Stop -> final (every text block of the turn; the adapter
//   drops blocks it already sent);  StopFailure -> failed final;
//   PreToolUse / PostToolUse -> activity running (PostToolUse(AskUserQuestion) -> answer);
//   Notification -> waiting-approval | waiting-input (with its message) | idle;
//   SessionEnd (not /clear) -> end.
// A prompt, final or answer the daemon did not take (down, restarting, slow) is spooled and
// resent ahead of the next successful call, so a daemon hiccup delays rather than loses it.
// A session Claude Code gives no channel (ccds, or no flag) has its Telegram messages queued
// by the daemon; the Stop call gets them back and blocks the stop with them, so the session
// continues with those messages as its next turn.
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
import { nearestClaude } from '../shared/process-tree.mjs';

const TIMEOUT_MS = 2000;
const QUESTION_TIMEOUT_MS = 10 * 60000;   // the settings hook timeout must exceed this
const SPOOL_FILE = path.join(path.dirname(RUNTIME_FILE), 'spool.jsonl');
const SPOOL_TTL_MS = 60 * 60000;
const NOTIFICATION_STATES = { permission_prompt: 'waiting-approval', elicitation_dialog: 'waiting-input', idle_prompt: 'idle' };

const isRealUser = (e) => {
  if (e?.type !== 'user' || e.isMeta) return false;
  const c = e.message?.content;
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

export const finalAssistantText = (jsonl) => turnTexts(jsonl).join('\n\n');

/** `Q -> A` lines of an answered AskUserQuestion, from its tool response or input. */
export function answerText(payload) {
  const answers = payload.tool_response?.answers ?? payload.tool_input?.answers;
  if (!answers || typeof answers !== 'object') return '';
  return Object.entries(answers).map(([q, a]) => `${q} -> ${[].concat(a).join(', ')}`).join('\n');
}

/** The mirror call for one hook payload, or null when there is nothing to send. */
export function mirrorFor(payload, env = process.env) {
  // The current id, and the one this claude process started with (its channel's id).
  const sessionIds = [...new Set([payload?.session_id, env.CLAUDE_CODE_SESSION_ID].filter(Boolean))];
  if (!sessionIds.length) return null;
  const base = { sessionIds };
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
    return texts.length ? { ...base, kind: 'final', texts } : null;
  }
  // A turn ended by an API error fires StopFailure instead of Stop; it waits for the human.
  if (payload?.hook_event_name === 'StopFailure') {
    const text = [payload.error_type ?? 'unknown', payload.error_message].filter(Boolean).join(': ');
    return { ...base, kind: 'final', status: 'failed', text };
  }
  const event = payload?.hook_event_name;
  if (event === 'PostToolUse' && payload.tool_name === 'AskUserQuestion') return { ...base, kind: 'answer', text: answerText(payload) };
  if ((event === 'PreToolUse' && payload.tool_name !== 'AskUserQuestion') || event === 'PostToolUse') return { ...base, kind: 'activity', state: 'running' };
  if (event === 'Notification') {
    const state = NOTIFICATION_STATES[payload.notification_type];
    if (!state) return null;
    // What it waits for ("Claude needs your permission to use Bash") is worth a message.
    const text = state !== 'idle' && typeof payload.message === 'string' ? payload.message.trim() : '';
    return { ...base, kind: 'activity', state, ...(text ? { text } : {}) };
  }
  // /clear ends the old session id, but the claude process and its channel live on.
  if (event === 'SessionEnd') return payload.reason === 'clear' ? null : { ...base, kind: 'end' };
  return null;
}

/** The `question` call for a PreToolUse(AskUserQuestion) payload, or null. */
export function questionFor(payload, env = process.env) {
  if (payload?.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'AskUserQuestion') return null;
  const questions = payload.tool_input?.questions;
  const sessionIds = [...new Set([payload.session_id, env.CLAUDE_CODE_SESSION_ID].filter(Boolean))];
  return Array.isArray(questions) && questions.length && sessionIds.length ? { sessionIds, questions, wait: true } : null;
}

/** PreToolUse output that answers AskUserQuestion without showing its dialog. */
export function answerOutput(toolInput, answers) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } } };
}

/** Stop output that continues the session with queued Telegram messages, or null. */
export function deliverOutput(deliver) {
  if (!Array.isArray(deliver) || !deliver.length) return null;
  const msgs = deliver.map((d) => `Message from Telegram${d?.user ? ` (${d.user})` : ''}:\n${String(d?.text ?? '')}`);
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

/** Resend spooled calls oldest first; claimed by rename so concurrent hooks never double-send. */
export async function flushSpool({ file = SPOOL_FILE, now = Date.now(), send = (c) => callHub('mirror', c) } = {}) {
  const claimed = `${file}.${process.pid}`;
  try { fs.renameSync(file, claimed); } catch { return; }
  let lines = [];
  try { lines = fs.readFileSync(claimed, 'utf8').split('\n'); } catch { /* gone */ } finally { fs.rmSync(claimed, { force: true }); }
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (!e?.call || now - e.at > SPOOL_TTL_MS) continue;
    if ((await send(e.call)) === null) spool(e.call, { file, now: e.at });
  }
}

/** Content worth resending; pure state changes are superseded by the next hook anyway. */
const spoolable = (call) => (call.kind !== 'activity' && call.kind !== 'end') || Boolean(call.text);

async function main() {
  if (!fs.existsSync(RUNTIME_FILE)) return;
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const payload = JSON.parse(raw || '{}');
  // Only the dedicated AskUserQuestion entry (long timeout) waits: Claude Code merges hook
  // entries with an identical command, so the catch-all one must not be that entry's twin.
  const question = process.argv.includes('--question') ? questionFor(payload) : null;
  setTimeout(() => process.exit(0), (question ? QUESTION_TIMEOUT_MS : TIMEOUT_MS) + 500).unref();
  if (question) {
    const r = await callHub('question', question, { timeoutMs: QUESTION_TIMEOUT_MS });
    // Flushed before the process exits: stdout may be an asynchronous pipe.
    if (r?.answers && typeof r.answers === 'object') await new Promise((done) => process.stdout.write(JSON.stringify(answerOutput(payload.tool_input, r.answers)), done));
    return;
  }
  const call = mirrorFor(payload);
  if (!call) return;
  // No session matched: after /clear both ids are new. Retry naming this hook's own claude
  // process (the one owning the channel). Looked up only now — a process-table query is slow,
  // so never for the per-tool activity calls — and never from CLAUDE_PID, which a nested
  // `claude` inherits from its parent.
  if (fs.existsSync(SPOOL_FILE)) await flushSpool();
  let r = await callHub('mirror', call);
  if (r === null && spoolable(call)) { spool(call); return; }
  if (r?.routed === false && call.kind !== 'activity') {
    const claudePid = nearestClaude(process.ppid);
    if (claudePid) r = await callHub('mirror', { ...call, claudePid, retry: true });
  }
  const out = payload.hook_event_name === 'Stop' && deliverOutput(r?.deliver);
  if (out) await new Promise((done) => process.stdout.write(JSON.stringify(out), done));
}

if (isMain(import.meta.url)) main().catch(() => {}).finally(() => process.exit(0));
