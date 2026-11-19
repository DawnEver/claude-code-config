// scripts/bridge/agy-adapter.mjs — Antigravity CLI (agy) sessions as one bridge host (docs/bridge.md, docs/agy.md).
//
// agy has no shared daemon and no channel: its hooks are the only signal. scripts/hooks/agy-hook.mjs
// calls forwardAgyHook(event, input) on SessionStart, PreInvocation, PreToolUse, PostToolUse and
// Stop; it makes ONE call `agy {token, sessionId, event, ...}` over the Claude adapter's 127.0.0.1
// IPC (runtime.json; the daemon routes the method here) and is answered at once. The adapter emits
// the host-neutral events every adapter emits (see daemon.mjs): up, status, prompt, progress,
// final, notice, down, and keeps the session's ActivityBoard.
// Telegram -> agy: a message is queued (on disk when `queueDir` is set) and handed to the session's
// next Stop hook, which continues the session with it (`{decision: "continue", reason}`), exactly as
// a Claude session without a channel. agy has no SessionEnd and no process to watch, so a session
// silent for `idleDownMs` is reported down; its next hook brings it back up under the same id.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { ActivityBoard } from './activity-board.mjs';
import { BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './runtime-paths.mjs';

/** Each agy conversation's workspace, as its hooks named it: the usage store's project (agy's transcripts carry no cwd). */
export const AGY_CWD_FILE = path.join(BRIDGE_RUNTIME_DIR, 'agy-cwd.json');
const CWD_KEEP = 2000;

export function readAgyCwds(file = AGY_CWD_FILE) {
  try { const m = JSON.parse(fs.readFileSync(file, 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

function noteCwd(file, id, cwd) {
  try {
    const m = readAgyCwds(file);
    if (m[id] === cwd) return;
    delete m[id];
    m[id] = cwd;
    const keep = Object.fromEntries(Object.entries(m).slice(-CWD_KEEP));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keep));
    fs.renameSync(tmp, file);
  } catch { /* the project column stays empty */ }
}

export const AGY_EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
const WAITING = new Set(['waiting-approval', 'waiting-input']);
/** A session no hook has spoken for this long is gone (agy has no SessionEnd). */
const IDLE_DOWN_MS = 3 * 3600000;
/** A turn still "running" this long after its last hook was cut off (Ctrl-C fires no Stop). */
const RUNNING_DOWN_MS = 12 * 3600000;
const SWEEP_MS = 60000;
// The tools that are tasks on the activity board, by agy tool name.
const TASK_TOOLS = { run_command: 'shell', invoke_subagent: 'agent' };

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A tool call's task id: agy's own id when it gives one, else stable across Pre and Post. */
export function toolTaskId(sessionId, invocationNum, toolCall) {
  if (typeof toolCall?.id === 'string' && toolCall.id) return toolCall.id.slice(0, 128);
  const h = crypto.createHash('sha1').update(JSON.stringify([sessionId, invocationNum ?? null, toolCall?.name ?? '', toolCall?.args ?? null])).digest('hex');
  return `agy-${h.slice(0, 24)}`;
}

/** What a tool call does, in a line: a command's CommandLine, a subagent's Role. */
function toolLabel(toolCall) {
  const a = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {};
  return oneLine(a.CommandLine ?? a.Role ?? a.toolSummary ?? toolCall?.name ?? '');
}

export class AgyAdapter extends EventEmitter {
  constructor({ now = Date.now, queueDir = null, cwdFile = null, idleDownMs = IDLE_DOWN_MS, runningDownMs = RUNNING_DOWN_MS } = {}) {
    super();
    this.agent = 'agy';
    Object.assign(this, { now, queueDir, cwdFile, idleDownMs, runningDownMs });
    // sessionId -> { cwd, activity, stateAt, lastAt, tasks, queued, sent, remoteTurn }
    this.sessions = new Map();
  }

  /** Report silent sessions down, every SWEEP_MS (unref'd: never keeps the daemon alive). */
  start() {
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
    return this;
  }

  close() { clearInterval(this.timer); }

  sweep(now = this.now()) {
    for (const [id, s] of this.sessions) {
      const limit = s.activity === 'running' ? this.runningDownMs : this.idleDownMs;
      if (now - s.lastAt >= limit) this.#down(id);
    }
  }

  // ── The inbound queue, per session id (as claude-adapter.mjs) ──
  #queueFile(id) { return this.queueDir && path.join(this.queueDir, `agy-${crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16)}.json`); }

  #loadQueue(id) {
    const file = this.#queueFile(id);
    if (!file) return [];
    try { const q = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(q?.messages) ? q.messages : []; } catch { return []; }
  }

  #saveQueue(id, messages) {
    const file = this.#queueFile(id);
    if (!file) return;
    if (!messages.length) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(this.queueDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessionId: id, messages }));
    fs.renameSync(tmp, file);
  }

  #up(id, cwd) {
    if (cwd && this.cwdFile) noteCwd(this.cwdFile, id, cwd);
    let s = this.sessions.get(id);
    if (s) { if (cwd && !s.cwd) s.cwd = cwd; return s; }
    s = { cwd: cwd ?? null, activity: null, stateAt: 0, lastAt: this.now(), tasks: new ActivityBoard(), queued: this.#loadQueue(id), sent: new Set(), remoteTurn: false };
    this.sessions.set(id, s);
    this.emit('up', { id, cwd: s.cwd, seat: null, provider: null, name: null, backlog: [] });
    return s;
  }

  #down(id) {
    if (!this.sessions.delete(id)) return;
    this.#emitStatus(id);
    this.emit('down', { id });
  }

  #state(id, s, state, at) {
    if (at < s.stateAt) return;   // a hook stamped earlier never overwrites a later one
    s.activity = state;
    s.stateAt = at;
    this.#emitStatus(id);
  }

  /**
   * One hook call (the IPC method `agy`, token already checked). Returns what the hook acts on:
   * `{ok, deliver?: [{text, user}]}` -- deliver only from a Stop, the queued Telegram messages.
   */
  handle(p = {}) {
    const id = typeof p.sessionId === 'string' && p.sessionId.length <= 128 ? p.sessionId : '';
    if (!id || !AGY_EVENTS.includes(p.event)) throw Object.assign(new Error('agy: sessionId and a known event required'), { code: -32602 });
    const at = Number.isFinite(p.at) ? p.at : this.now();
    const s = this.#up(id, typeof p.cwd === 'string' && p.cwd ? p.cwd : null);
    s.lastAt = this.now();
    if (p.event === 'SessionStart') {
      if (!s.activity) this.#state(id, s, 'idle', at);
      return { ok: true };
    }
    if (p.event === 'PreInvocation') {
      // invocationNum 1 opens a turn: a prompt typed here, or a continuation the Stop hook asked for.
      if (p.invocationNum === 1 || p.invocationNum === undefined) {
        s.tasks.settleForeground(at);
        s.sent = new Set();
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (text && p.continuationActive !== true) { s.remoteTurn = false; this.emit('prompt', { id, text }); }
      }
      this.#state(id, s, 'running', at);
      return { ok: true };
    }
    if (p.event === 'PreToolUse' || p.event === 'PostToolUse') {
      const tc = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : null;
      const kind = TASK_TOOLS[tc?.name];
      if (kind) {
        const tid = toolTaskId(id, p.invocationNum, tc);
        if (p.event === 'PreToolUse') s.tasks.start(tid, { kind, label: toolLabel(tc), at });
        else s.tasks.end(tid, { status: p.failed === true ? 'failed' : 'completed', at });
      }
      this.#state(id, s, 'running', at);
      if (p.event === 'PostToolUse') this.emit('progress', { id, text: '' });
      return { ok: true };
    }
    // Stop: the turn's answer blocks not sent yet, then the queue.
    s.tasks.settleForeground(at);
    const blocks = (Array.isArray(p.texts) ? p.texts : [p.text]).map((t) => String(t ?? '').trim()).filter(Boolean);
    const fresh = blocks.filter((b) => !s.sent.has(b));
    for (const b of blocks) s.sent.add(b);
    const failed = typeof p.terminationReason === 'string' && /error|fail/i.test(p.terminationReason);
    if (fresh.length || failed) this.emit('final', { id, text: fresh.join('\n\n'), ...(failed ? { status: 'failed' } : {}) });
    this.#state(id, s, 'idle', at);
    if (!s.queued.length || failed) return { ok: true };
    const deliver = s.queued;
    s.queued = [];
    this.#saveQueue(id, []);
    s.sent = new Set();
    s.remoteTurn = true;
    this.#state(id, s, 'running', this.now());
    return { ok: true, deliver };
  }

  // ── host interface used by the daemon ──

  async inject(id, text, user, { userId = '' } = {}) {
    const msg = { text, user: user ?? '', userId };
    const s = this.sessions.get(id);
    if (!s) {
      if (!this.queueDir) throw new Error('session not running');
      this.#saveQueue(id, [...this.#loadQueue(id), msg]);
      return { queued: true, note: `queued: this session is not running now; the message is delivered when its next turn ends (agy --conversation ${id}).` };
    }
    s.queued.push(msg);
    this.#saveQueue(id, s.queued);
    const when = s.activity === 'running' ? 'it is delivered when the current turn ends'
      : 'the message waits for its next turn to end (type something locally to wake it)';
    return { queued: true, note: `queued: Antigravity has no inbound channel, so ${when}.` };
  }

  status(id) { return this.sessions.has(id) ? 'hooks reporting' : 'not running'; }

  statusSnapshot(id) {
    const s = this.sessions.get(id);
    if (!s) return { state: 'disconnected' };
    const tasks = s.tasks.list(this.now());
    const state = s.activity ?? 'unknown';
    return { state, ...(WAITING.has(state) && s.waitText ? { waiting: s.waitText } : {}), ...(tasks.length ? { tasks } : {}) };
  }

  #emitStatus(id) { this.emit('status', { id, ...this.statusSnapshot(id) }); }

  // agy's permission prompts and ask_question dialogs reach no hook: nothing to answer from Telegram.
  answerApproval() { return false; }
  answerQuestion() { return false; }
  releaseQuestion() { return false; }
}

// ── Hook side: scripts/hooks/agy-hook.mjs calls forwardAgyHook ──

const TAIL_BYTES = 256 * 1024;
const CALL_MS = 1200;

/**
 * The answer blocks of the transcript's last turn (agy `transcript.jsonl`): every PLANNER_RESPONSE
 * `content` after the last USER_INPUT or SYSTEM_MESSAGE, read from its tail.
 */
export function agyTurnTexts(file) {
  let tail = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      tail = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, size - buf.length));
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  let texts = [];
  for (const l of tail.split('\n')) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }   // the cut first line
    if (e?.type === 'USER_INPUT' || e?.type === 'SYSTEM_MESSAGE') texts = [];
    else if (e?.type === 'PLANNER_RESPONSE' && typeof e.content === 'string' && e.content.trim()) texts.push(e.content.trim());
  }
  return texts;
}

/** The prompt a person typed, without agy's envelope (`<USER_REQUEST>` and its metadata blocks). */
export function agyPromptText(text) {
  const t = String(text ?? '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(t);
  return (m ? m[1] : t).trim();
}

const TELEGRAM_MESSAGE = 'Message from Telegram';

/** The hook payload (agy camelCase stdin) -> the IPC call's params. */
export function agyCallFor(event, input = {}) {
  const tc = input.toolCall && typeof input.toolCall === 'object' ? input.toolCall : null;
  return {
    sessionId: String(input.conversationId ?? ''), event, at: Date.now(),
    cwd: Array.isArray(input.workspacePaths) && input.workspacePaths[0] ? String(input.workspacePaths[0]) : input.cwd ?? null,
    ...(Number.isFinite(input.invocationNum) ? { invocationNum: input.invocationNum } : {}),
    ...(input.continuationActive === true ? { continuationActive: true } : {}),
    ...(event === 'PreInvocation' && input.lastUserInput ? { text: agyPromptText(input.lastUserInput) } : {}),
    ...(tc ? { toolCall: { name: String(tc.name ?? ''), ...(tc.id ? { id: String(tc.id) } : {}), args: tc.args ?? null } } : {}),
    ...(tc && (tc.error || tc.status === 'error') ? { failed: true } : {}),
    ...(event === 'Stop' && typeof input.terminationReason === 'string' ? { terminationReason: input.terminationReason } : {}),
    ...(event === 'Stop' && input.transcriptPath ? { texts: agyTurnTexts(input.transcriptPath) } : {}),
  };
}

/**
 * Forward one agy hook to the bridge daemon. Resolves `{}` or `{stopContinue}` (Stop only: the
 * queued Telegram messages, for the hook's `{decision: "continue", reason}`). Fails open and
 * silent: no daemon, a hung one or a refused call all resolve `{}` within CALL_MS.
 */
export async function forwardAgyHook(event, input, { runtimeFile = RUNTIME_FILE, call = null, timeoutMs = CALL_MS } = {}) {
  try {
    if (!AGY_EVENTS.includes(event) || !input?.conversationId || !fs.existsSync(runtimeFile)) return {};
    const send = call ?? (await import('../hooks/bridge-hook.js')).callHub;
    const r = await send('agy', agyCallFor(event, input), { runtimeFile, timeoutMs });
    if (event !== 'Stop' || !Array.isArray(r?.deliver) || !r.deliver.length) return {};
    return { stopContinue: r.deliver.map((d) => `${TELEGRAM_MESSAGE}${d?.user ? ` (${d.user})` : ''}:\n${String(d?.text ?? '')}`).join('\n\n') };
  } catch { return {}; }
}
