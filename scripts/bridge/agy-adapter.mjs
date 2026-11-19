// scripts/bridge/agy-adapter.mjs — Antigravity CLI (agy) sessions as one bridge host (docs/bridge.md, docs/agy.md).
//
// agy has no shared daemon and no channel: its hooks are the only signal. scripts/hooks/agy-hook.mjs
// calls forwardAgyHook(event, input) on SessionStart, PreInvocation, PreToolUse, PostToolUse and
// Stop; it makes ONE call `agy {token, sessionId, event, ...}` over the Claude adapter's 127.0.0.1
// IPC (runtime.json; the daemon routes the method here). Most calls answer at once; in a
// Telegram-started turn (`remoteTurn`), PreToolUse(ask_question) and permission-gated tools wait up
// to `waitMs` (10 min; the PreToolUse hook timeout is 660 s) for the user's answer on Telegram.
// The adapter emits the host-neutral events every adapter emits (see daemon.mjs): up, status,
// prompt, progress, final, notice, question, question-resolved, approval, approval-resolved, down,
// and keeps the session's ActivityBoard.
// Telegram -> agy: a message is queued (on disk when `queueDir` is set) and handed to the session's
// next Stop hook, which continues the session with it (`{decision: "continue", reason}`), marking
// `remoteTurn: true`. `/interrupt` sets a pending interrupt flag: a waiting question/approval is
// denied at once, the next PreToolUse is denied, and the next PreInvocation terminates the turn.
// agy has no SessionEnd and no process to watch, so a session silent for `idleDownMs` is reported
// down (withdrawing any pending controls); its next hook brings it back up under the same id.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { ActivityBoard } from './activity-board.mjs';
import { BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './runtime-paths.mjs';
import { tokens, base, isClaudeProcess, readProcessTable, ancestorsOf } from '../shared/process-tree.mjs';

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
/** How long a Telegram-started turn's question or approval waits for its answer (the hook's timeout must exceed it). */
export const WAIT_MS = 10 * 60000;
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
  constructor({ now = Date.now, queueDir = null, cwdFile = null, waitMs = WAIT_MS, idleDownMs = IDLE_DOWN_MS, runningDownMs = RUNNING_DOWN_MS } = {}) {
    super();
    this.agent = 'agy';
    Object.assign(this, { now, queueDir, cwdFile, waitMs, idleDownMs, runningDownMs });
    // sessionId -> { pending, localQuestions, interrupt, cwd, activity, stateAt, lastAt, tasks, queued, sent, remoteTurn }
    this.sessions = new Map();
  }

  /** Report silent sessions down, every SWEEP_MS (unref'd: never keeps the daemon alive). */
  start() {
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
    for (const [id, s] of this.sessions) this.#withdraw(id, s);
  }

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

  #up(id, cwd, name = null) {
    if (cwd && this.cwdFile) noteCwd(this.cwdFile, id, cwd);
    let s = this.sessions.get(id);
    if (s) {
      if (cwd && !s.cwd) s.cwd = cwd;
      if (name && name !== s.name) { s.name = name; this.emit('name', { id, name }); }
      return s;
    }
    s = { pending: new Map(), localQuestions: new Map(), interrupt: false, cwd: cwd ?? null, name: name ?? null, activity: null, stateAt: 0, lastAt: this.now(), tasks: new ActivityBoard(), queued: this.#loadQueue(id), sent: new Set(), remoteTurn: false };
    this.sessions.set(id, s);
    this.emit('up', { id, cwd: s.cwd, seat: null, provider: null, name: s.name, backlog: [] });
    return s;
  }

  #withdraw(id, s) {
    for (const [ref, w] of [...s.pending]) {
      if (w.approval) this.emit('approval-resolved', { id, ref, reason: 'correlation-withdrawn' });
      if (w.questions) this.emit('question-resolved', { id, ref });
      w.settle(null);
    }
    for (const ref of s.localQuestions.values()) this.emit('question-resolved', { id, ref });
    s.localQuestions.clear();
  }

  #down(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.#withdraw(id, s);
    this.#emitStatus(id);
    this.emit('down', { id });
  }

  #state(id, s, state, at) {
    if (at < s.stateAt) return;   // a hook stamped earlier never overwrites a later one
    s.activity = state;
    if (!WAITING.has(state)) s.waitText = null;
    s.stateAt = at;
    this.#emitStatus(id);
  }

  /**
   * One hook call (the IPC method `agy`, token already checked). Returns what the hook acts on:
   * `{ok, deliver?, decision?, reason?, terminate?, injectSteps?}`.
   */
  handle(p = {}) {
    const id = typeof p.sessionId === 'string' && p.sessionId.length <= 128 ? p.sessionId : '';
    if (!id || !AGY_EVENTS.includes(p.event)) throw Object.assign(new Error('agy: sessionId and a known event required'), { code: -32602 });
    const at = Number.isFinite(p.at) ? p.at : this.now();
    const s = this.#up(id, typeof p.cwd === 'string' && p.cwd ? p.cwd : null, typeof p.name === 'string' && p.name ? p.name : null);
    s.lastAt = this.now();
    if (p.turnOrigin === 'telegram') s.remoteTurn = true;
    else if (p.turnOrigin === 'local') s.remoteTurn = false;
    if (p.event === 'SessionStart') {
      if (!s.activity) this.#state(id, s, 'idle', at);
      return { ok: true };
    }
    if (p.event === 'PreInvocation') {
      // A /interrupt from Telegram: stop before the model runs, and clear the pending flag.
      if (s.interrupt) {
        s.interrupt = false;
        s.tasks.settleForeground(at);
        this.#state(id, s, 'idle', at);
        return { ok: true, terminate: true, reason: INTERRUPTED };
      }
      // Turn opening: whenever the session is not already mid-turn (`s.activity !== 'running'`,
      // covering multi-turn sessions where `invocationNum` increases monotonically across turns)
      // or explicitly at invocation 0/1.
      if (s.activity !== 'running' || p.invocationNum === 0 || p.invocationNum === 1) {
        s.tasks.settleForeground(at);
        s.sent = new Set();
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (text && p.continuationActive !== true) {
          if (p.turnOrigin !== 'telegram') s.remoteTurn = false;
          this.emit('prompt', { id, text });
        }
      }
      this.#state(id, s, 'running', at);
      return { ok: true };
    }
    if (p.event === 'PreToolUse' || p.event === 'PostToolUse') {
      const tc = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : null;
      if (p.event === 'PreToolUse' && s.interrupt) {
        s.interrupt = false;
        return { ok: true, decision: 'deny', reason: INTERRUPTED };
      }
      const kind = TASK_TOOLS[tc?.name];
      const tid = toolTaskId(id, p.invocationNum, tc);
      if (p.event === 'PostToolUse') {
        if (kind) s.tasks.end(tid, { status: p.failed === true ? 'failed' : 'completed', at });
        this.#state(id, s, 'running', at);
        // A question shown read-only (a local turn) was answered in the terminal: its Telegram message goes inactive.
        const ref = s.localQuestions.get(tid);
        if (ref) { s.localQuestions.delete(tid); this.emit('question-resolved', { id, ref }); this.emit('notice', { id, text: 'answered locally' }); }
        this.emit('progress', { id, text: '' });
        return { ok: true };
      }
      this.#state(id, s, 'running', at);
      if (tc?.name === 'ask_question') return this.#question(id, s, tid, tc, p);
      if (p.needsApproval === true && s.remoteTurn) return this.#approval(id, s, tid, kind, tc, at);
      if (kind) s.tasks.start(tid, { kind, label: toolLabel(tc), at });
      return { ok: true };
    }
    // Stop: the turn's answer blocks not sent yet, then the queue.
    s.interrupt = false;
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

  /**
   * An ask_question call. In a turn started from Telegram it is posted with buttons and the hook
   * waits (up to waitMs) for the answer, which denies the call with the answer as its reason: the
   * model reads it as the tool's result without hanging on a local TUI prompt. In a local turn it
   * is posted read-only and the terminal dialog runs; PostToolUse marks it answered.
   */
  #question(id, s, tid, tc, p) {
    const questions = agyQuestions(tc.args);
    if (!questions.length) return { ok: true };
    const ref = crypto.randomBytes(12).toString('hex');
    if (!s.remoteTurn) {
      s.localQuestions.set(tid, ref);
      this.emit('question', { id, ref, questions, answerable: false });
      return { ok: true };
    }
    s.waitText = questions.map((q) => q.question).filter(Boolean).join(' / ');
    this.#state(id, s, 'waiting-input', p.at ?? this.now());
    const waited = this.#wait(id, s, ref, { questions }, (answers) => {
      if (answers === INTERRUPT) return { ok: true, decision: 'deny', reason: INTERRUPTED };
      if (!answers) { this.emit('question-resolved', { id, ref }); return { ok: true }; }   // unanswered: the terminal dialog runs
      const lines = questions.map((q) => `${q.question} -> ${[].concat(answers[q.id] ?? []).map(String).join(', ')}`);
      return { ok: true, decision: 'deny', reason: `${QUESTION_ANSWERED}\n${lines.join('\n')}` };
    });
    this.emit('question', { id, ref, questions, answerable: true });
    return waited;
  }

  /**
   * A permission-gated tool in a turn started from Telegram: Approve / Deny there. If the daemon
   * does not offer buttons (`approvalsFromTelegram` off, or no Topic / allowlist), `releaseApproval`
   * releases the wait as soon as the notice is posted so the hook never blocks.
   */
  #approval(id, s, tid, kind, tc, at) {
    const ref = crypto.randomBytes(12).toString('hex');
    const label = toolLabel(tc);
    const summary = `${tc?.name ?? 'tool'}${label && label !== tc?.name ? `: ${label}` : ''}`.slice(0, 300);
    s.waitText = summary;
    this.#state(id, s, 'waiting-approval', this.now());
    const waited = this.#wait(id, s, ref, { approval: true }, (allow) => {
      if (allow === INTERRUPT) return { ok: true, decision: 'deny', reason: INTERRUPTED };
      if (allow === null) {
        this.emit('approval-resolved', { id, ref, reason: 'timeout' });
        if (kind) s.tasks.start(tid, { kind, label: toolLabel(tc), at });
        return { ok: true };   // no answer or not offered: agy asks locally
      }
      if (allow && kind) s.tasks.start(tid, { kind, label: toolLabel(tc), at });
      return { ok: true, decision: allow ? 'allow' : 'deny', ...(allow ? {} : { reason: 'Denied from Telegram.' }) };
    });
    this.emit('approval', { id, ref, answerable: true, summary: `${summary}${tc?.args ? `\n${JSON.stringify(tc.args).slice(0, 1500)}` : ''}` });
    return waited;
  }

  /** Hold the hook's call until `ref` is answered, interrupted or waitMs passes (null). */
  #wait(id, s, ref, what, finish) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), this.waitMs);
      timer.unref?.();
      const settle = (v) => {
        if (!s.pending.has(ref)) return;
        clearTimeout(timer);
        s.pending.delete(ref);
        if (this.sessions.get(id) === s) this.#state(id, s, 'running', this.now());
        resolve(finish(v));
      };
      s.pending.set(ref, { ...what, settle });
    });
  }

  answerQuestion(ref, answers, id) {
    const w = this.sessions.get(id)?.pending.get(ref);
    if (!w?.questions || !answers || w.questions.some((q) => !answers[q.id]?.length)) return false;
    w.settle(answers);
    return true;
  }

  answerApproval(ref, allow, id) {
    const w = this.sessions.get(id)?.pending.get(ref);
    if (!w?.approval) return false;
    w.settle(!!allow);
    return true;
  }

  /** The question could not be shown on Telegram: let the terminal dialog run. */
  releaseQuestion(ref, id) {
    const w = this.sessions.get(id)?.pending.get(ref);
    if (!w?.questions) return false;
    w.settle(null);
    return true;
  }

  /** The approval could not be shown on Telegram: let the terminal prompt run. */
  releaseApproval(ref, id) {
    const w = this.sessions.get(id)?.pending.get(ref);
    if (!w?.approval) return false;
    w.settle(null);
    return true;
  }

  /**
   * /interrupt: deny any waiting question/approval now, and arm the session's interrupt flag so
   * the next PreToolUse is denied or the next PreInvocation terminates the turn.
   */
  async interrupt(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.interrupt = true;
    for (const w of [...s.pending.values()]) w.settle(INTERRUPT);
    return true;
  }
}

const INTERRUPT = Symbol('interrupt');
const INTERRUPTED = 'Interrupted from Telegram.';
const QUESTION_ANSWERED = 'User answered via Telegram:';

/** ask_question args (questions: an array, or the JSON string agy records) -> the daemon's question shape. */
export function agyQuestions(args) {
  let qs = args?.questions;
  if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch { qs = []; } }
  return (Array.isArray(qs) ? qs : []).slice(0, 10).map((q, i) => ({
    id: String(i), header: '', question: String(q?.question ?? ''), isOther: true, isSecret: false, multiSelect: q?.is_multi_select === true,
    options: Array.isArray(q?.options) ? q.options.map((o) => (typeof o === 'string' ? { label: o, description: '' } : { label: String(o?.label ?? ''), description: String(o?.description ?? '') })) : null,
  })).filter((q) => q.question);
}
// ── Hook side: scripts/hooks/agy-hook.mjs calls forwardAgyHook ──

const TAIL_BYTES = 256 * 1024;
const CALL_MS = 1200;
const WAIT_CALL_MS = WAIT_MS + 5000;
export const AGY_APP_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
export const AGY_SETTINGS_FILE = path.join(AGY_APP_DIR, 'settings.json');
const SESSION_KIND_FILE = path.join(BRIDGE_RUNTIME_DIR, 'agy-session-kind.json');
const SUBAGENT_WORKTREE_RE = /[\\/]\.gemini[\\/]antigravity[^\\/]*[\\/]worktrees[\\/]/i;
const PRINT_FLAG_RE = /^(?:-p|--print|--prompt)(?:=|$)/;

function readConversationMeta(id, appDir) {
  if (!id || !appDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appDir, 'cache', 'conversation_metadata.json'), 'utf8'));
    return raw?.conversations?.[id] ?? null;
  } catch { return null; }
}

const isAgyCliProcess = (cmd) => /^agy(?:\.exe)?$/i.test(base(tokens(cmd, 1)[0]));
const isCodexCliProcess = (cmd) => /^codex(?:\.exe)?$/i.test(base(tokens(cmd, 1)[0]));
const hasPrintModeFlag = (cmd) => tokens(cmd, 32).slice(1).some((t) => PRINT_FLAG_RE.test(t));

/**
 * Only top-level interactive main sessions belong on the bridge/dashboard (matching Claude's
 * `isMainSession`). Filters out:
 *   1. Subagents (`conversation_metadata.json` `is_internal: true`, missing `presence/<id>.lock`
 *      when `presence/` exists, or a `.gemini/antigravity-cli/worktrees/` cwd);
 *   2. Nested `agy` started from inside a Claude, Codex, or outer `agy` session;
 *   3. Non-interactive one-shot `agy -p` / `--print` / `--prompt` runs.
 * Process ancestry is checked at most once per `conversationId` and cached in `kindFile`.
 */
export function isAgyMainSession(input = {}, {
  appDir = AGY_APP_DIR,
  kindFile = SESSION_KIND_FILE,
  env = process.env,
  ppid = process.ppid,
  ancestry = null,
} = {}) {
  const id = String(input?.conversationId ?? '');
  if (!id) return false;
  if (input.isSubagent === true || input.isInternal === true) return false;
  const cwd = Array.isArray(input.workspacePaths) && input.workspacePaths[0] ? String(input.workspacePaths[0]) : String(input.cwd ?? '');
  if (SUBAGENT_WORKTREE_RE.test(cwd)) return false;
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_PID || env.CODEX_THREAD_ID) return false;
  if (appDir) {
    const meta = readConversationMeta(id, appDir);
    if (meta?.is_internal === true || meta?.summary?.Internal === true) return false;
    const presenceDir = path.join(appDir, 'presence');
    if (fs.existsSync(presenceDir) && !fs.existsSync(path.join(presenceDir, `${id}.lock`))) return false;
  }
  if (ancestry === false) return true;
  if (!ancestry && kindFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(kindFile, 'utf8'))?.[id];
      if (typeof cached === 'boolean') return cached;
    } catch { /* first check for this conversationId */ }
  }
  const chain = Array.isArray(ancestry) ? ancestry : (() => {
    const { table } = readProcessTable();
    return ancestorsOf(ppid, table);
  })();
  let main = true;
  if (chain.length) {
    if (chain.some((a) => isClaudeProcess(a.cmd) || isCodexCliProcess(a.cmd))) main = false;
    const agys = chain.filter((a) => isAgyCliProcess(a.cmd));
    if (agys.length > 1) main = false;
    if (agys[0] && hasPrintModeFlag(agys[0].cmd)) main = false;
  }
  if (!ancestry && kindFile && chain.length) {
    try {
      let map = {};
      try { map = JSON.parse(fs.readFileSync(kindFile, 'utf8')) || {}; } catch {}
      delete map[id];
      map[id] = main;
      const keep = Object.fromEntries(Object.entries(map).slice(-500));
      fs.mkdirSync(path.dirname(kindFile), { recursive: true });
      const tmp = `${kindFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(keep));
      fs.renameSync(tmp, kindFile);
    } catch { /* best effort cache */ }
  }
  return main;
}
/** Tools agy gates on permission when `toolPermission` is not `always-proceed`. */
export const APPROVAL_TOOLS = new Set(['run_command', 'write_file', 'edit_file']);

/** Whether agy's `settings.json` gates `toolName` on user approval (`toolPermission !== 'always-proceed'`). */
export function agyNeedsApproval(toolName, settingsFile = AGY_SETTINGS_FILE) {
  if (!APPROVAL_TOOLS.has(toolName)) return false;
  let perm = null;
  try { perm = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.toolPermission; } catch { /* missing -> default */ }
  return perm !== 'always-proceed';
}

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
export function agyCallFor(event, input = {}, { settingsFile = AGY_SETTINGS_FILE, appDir = AGY_APP_DIR } = {}) {
  const tc = input.toolCall && typeof input.toolCall === 'object' ? input.toolCall : null;
  const failed = Boolean(input.error || tc?.error || tc?.status === 'error');
  const needsApproval = event === 'PreToolUse' && (input.needsApproval === true
    || (input.needsApproval !== false && agyNeedsApproval(tc?.name, settingsFile)));
  const id = String(input.conversationId ?? '');
  const title = appDir ? String(readConversationMeta(id, appDir)?.summary?.Title ?? '').trim() : '';
  return {
    sessionId: id, event, at: Date.now(),
    cwd: Array.isArray(input.workspacePaths) && input.workspacePaths[0] ? String(input.workspacePaths[0]) : input.cwd ?? null,
    ...(title ? { name: title } : {}),
    ...(Number.isFinite(input.invocationNum) ? { invocationNum: input.invocationNum } : {}),
    ...(input.continuationActive === true ? { continuationActive: true } : {}),
    ...(input.turnOrigin === 'telegram' || input.turnOrigin === 'local' ? { turnOrigin: input.turnOrigin } : {}),
    ...(event === 'PreInvocation' && input.lastUserInput ? { text: agyPromptText(input.lastUserInput) } : {}),
    ...(tc ? { toolCall: { name: String(tc.name ?? ''), ...(tc.id ? { id: String(tc.id) } : {}), args: tc.args ?? null } } : {}),
    ...(failed ? { failed: true } : {}),
    ...(needsApproval ? { needsApproval: true } : {}),
    ...(event === 'Stop' && typeof input.terminationReason === 'string' ? { terminationReason: input.terminationReason } : {}),
    ...(event === 'Stop' && input.transcriptPath ? { texts: agyTurnTexts(input.transcriptPath) } : {}),
  };
}

/**
 * Forward one agy hook to the bridge daemon. Returns `{ injectSteps?, stopContinue?, decision?, reason?, terminate? }`:
 *   - Stop with queued Telegram messages -> `{ stopContinue }`
 *   - PreToolUse question answer / approval / interrupt -> `{ decision, reason? }`
 *   - PreInvocation interrupt -> `{ terminate: true, reason? }`
 *   - SessionStart / PreInvocation injected steps -> `{ injectSteps }`
 * Fails open and silent (`{}`) if the daemon is unreachable, refuses, or times out.
 */
export async function forwardAgyHook(event, input, opts = {}) {
  const { runtimeFile = RUNTIME_FILE, settingsFile = AGY_SETTINGS_FILE, call = null, timeoutMs } = opts;
  const isolated = Boolean(call) || (opts.runtimeFile !== undefined && opts.runtimeFile !== RUNTIME_FILE);
  const appDir = opts.appDir !== undefined ? opts.appDir : (isolated ? null : AGY_APP_DIR);
  const ancestry = opts.ancestry !== undefined ? opts.ancestry : (isolated ? false : null);
  try {
    if (!AGY_EVENTS.includes(event) || !input?.conversationId || !fs.existsSync(runtimeFile)) return {};
    if (!isAgyMainSession(input, { appDir, ancestry })) return {};
    const params = agyCallFor(event, input, { settingsFile, appDir });
    const interactive = event === 'PreToolUse' && (params.toolCall?.name === 'ask_question' || params.needsApproval === true);
    const send = call ?? (await import('../hooks/bridge-hook.js')).callHub;
    const r = await send('agy', params, { runtimeFile, timeoutMs: timeoutMs ?? (interactive ? WAIT_CALL_MS : CALL_MS) });
    if (!r || r.error) return {};
    const out = {};
    if (Array.isArray(r.injectSteps) && r.injectSteps.length) out.injectSteps = r.injectSteps;
    if (event === 'PreInvocation' && r.terminate === true) {
      out.terminate = true;
      if (typeof r.reason === 'string' && r.reason) out.reason = r.reason;
    }
    if (event === 'PreToolUse' && typeof r.decision === 'string' && r.decision) {
      out.decision = r.decision;
      if (typeof r.reason === 'string' && r.reason) out.reason = r.reason;
    }
    if (event === 'Stop' && Array.isArray(r.deliver) && r.deliver.length) {
      out.stopContinue = r.deliver.map((d) => `${TELEGRAM_MESSAGE}${d?.user ? ` (${d.user})` : ''}:\n${String(d?.text ?? '')}`).join('\n\n');
    }
    return out;
  } catch { return {}; }
}
