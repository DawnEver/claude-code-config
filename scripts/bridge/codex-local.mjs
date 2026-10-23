// Read-only visibility for Codex sessions outside the shared app-server. A rollout is
// evidence of recent activity, NOT proof that a TUI still holds the session. Never
// resume one here: doing so would create a second writer, not attach to its live TUI.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexHome } from '../shared/codex-home.mjs';

const READ_BYTES = 1024 * 1024;
const WINDOW_MS = 10 * 60000;
const textOf = (content = []) => content.filter(c => ['text', 'Text', 'input_text', 'output_text'].includes(c?.type))
  .map(c => c.text ?? '').join('\n').trim();

async function* rollouts(dir, depth = 3) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth) yield* rollouts(file, depth - 1);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield file;
  }
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** A bounded, incremental transcript observer. All emitted text is conversation text;
 * command output, tool arguments, reasoning, instructions, and historical prompts stay local. */
export class CodexLocalObserver extends EventEmitter {
  constructor({ root = path.join(resolveCodexHome(), 'sessions'), sources = ['cli', 'vscode'], now = Date.now,
    activityWindowMs = WINDOW_MS } = {}) {
    super();
    Object.assign(this, { root, sources, now, activityWindowMs });
    this.startedAt = now();
    this.files = new Map();
    this.threads = new Map();
  }

  has(id) { return this.threads.has(id); }

  statusSnapshot(id) {
    return this.has(id) ? { state: 'unknown', observationOnly: true } : { state: 'disconnected' };
  }

  controlError(id) {
    return new Error(`Codex ${id} is observation-only (outside the shared app-server). Use its local TUI; ` +
      `to enable Telegram control, stop that TUI first, then run codc resume ${id}. No parallel session was started.`);
  }

  async refresh(excluded = new Set()) {
    const present = new Set();
    for await (const file of rollouts(this.root)) {
      present.add(file);
      try { await this.#read(file, excluded); }
      catch (e) { this.emit('warn', `local rollout: ${e.code ?? 'read failed'}`); }
    }
    for (const [file, state] of this.files) {
      if (!present.has(file)) { this.#drop(state.id); this.files.delete(file); }
    }
    for (const [id, thread] of this.threads) {
      if (excluded.has(id)) this.threads.delete(id); // Shared takeover must not close its Topic.
      else if (this.now() - thread.lastAt >= this.activityWindowMs) this.#drop(id);
    }
  }

  #drop(id) {
    if (this.threads.delete(id)) this.emit('down', { id });
  }

  #register(state, at) {
    const existing = this.threads.get(state.id);
    if (existing) { existing.lastAt = Math.max(existing.lastAt, at); return; }
    this.threads.set(state.id, { lastAt: at });
    this.emit('up', { id: state.id, cwd: state.cwd, branch: state.branch, backlog: [], observationOnly: true });
    this.emit('notice', { id: state.id, text: 'Observation only: local Codex session is outside the shared app-server. ' +
      'Messages are mirrored from its rollout; reply and interrupt require the local TUI.' });
  }

  async #read(file, excluded) {
    const stat = await fs.stat(file);
    let state = this.files.get(file);
    if (!state || stat.size < state.offset) {
      const fd = await fs.open(file, 'r');
      let head;
      try {
        const buf = Buffer.alloc(Math.min(stat.size, READ_BYTES));
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString('utf8').split('\n').map(parse).find(e => e?.type === 'session_meta')?.payload;
      } finally { await fd.close(); }
      if (!head) return; // First metadata line may still be in flight.
      const id = head.id ?? head.session_id;
      const kind = typeof head.source === 'string' ? head.source : Object.keys(head.source ?? {})[0] ?? 'unknown';
      const allowed = id && !head.parent_thread_id && !head.parentThreadId && head.thread_source !== 'subagent' &&
        !/^subagent$/i.test(kind) && this.sources.includes(kind);
      state = { id, allowed, cwd: head.cwd, branch: head.git?.branch ?? null, offset: Math.max(0, stat.size - READ_BYTES),
        carry: Buffer.alloc(0), skipFirst: stat.size > READ_BYTES, initial: true, turnId: null, seen: new Set() };
      this.files.set(file, state);
    }
    // Ineligible and shared rollouts still advance their cursor. Removing a shared
    // subscription later must not replay messages already handled by the live adapter.
    if (!state.allowed || excluded.has(state.id)) {
      state.offset = stat.size; state.carry = Buffer.alloc(0); state.skipFirst = false; state.initial = false;
      this.threads.delete(state.id);
      return;
    }
    if (state.offset === stat.size) return;
    const fd = await fs.open(file, 'r');
    let chunk;
    try {
      const buf = Buffer.alloc(Math.min(READ_BYTES, stat.size - state.offset));
      const { bytesRead } = await fd.read(buf, 0, buf.length, state.offset);
      state.offset += bytesRead;
      chunk = Buffer.concat([state.carry, buf.subarray(0, bytesRead)]);
    } finally { await fd.close(); }
    const end = chunk.lastIndexOf(10);
    if (end < 0) {
      // Never retain an unbounded tool-output line; skip it until its newline.
      state.carry = chunk.length <= READ_BYTES ? chunk : Buffer.alloc(0);
      if (!state.carry.length) state.skipFirst = true;
      return;
    }
    state.carry = chunk.subarray(end + 1);
    let lines = chunk.subarray(0, end).toString('utf8').split('\n');
    if (state.skipFirst) { lines = lines.slice(1); state.skipFirst = false; }
    for (const line of lines) {
      const event = parse(line);
      if (event) this.#event(state, event, state.initial);
    }
    state.initial = false;
  }

  #event(state, event, initial) {
    const p = event.payload ?? {};
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || this.now() - at >= this.activityWindowMs) return;
    if (event.type === 'event_msg' && p.type === 'task_started') state.turnId = p.turn_id ?? null;
    const item = event.type === 'event_msg' && p.type === 'item_completed' ? p.item : null;
    const legacy = event.type === 'response_item' && p.type === 'message' ? p : null;
    const prompt = event.type === 'event_msg' && p.type === 'user_message' ? p.message :
      item && ['UserMessage', 'userMessage'].includes(item.type) ? textOf(item.content) : null;
    const assistant = item && ['AgentMessage', 'agentMessage'].includes(item.type) ? textOf(item.content) || item.text :
      legacy?.role === 'assistant' ? textOf(legacy.content) : null;
    const activity = prompt || assistant || (event.type === 'event_msg' && ['task_started', 'item_completed', 'task_complete'].includes(p.type));
    if (!activity) return;
    this.#register(state, at);
    if (initial && at < this.startedAt) return;
    const key = item?.id ?? legacy?.id;
    if (key && state.seen.has(key)) return;
    if (key) {
      state.seen.add(key);
      if (state.seen.size > 2048) state.seen.delete(state.seen.values().next().value);
    }
    const turnId = p.turn_id ?? state.turnId;
    if (prompt) this.emit('prompt', { id: state.id, text: prompt, turnId });
    if (assistant) this.emit((item ?? legacy)?.phase === 'final_answer' ? 'final' : 'message', { id: state.id, text: assistant, turnId });
    if (event.type === 'event_msg' && p.type === 'task_complete') state.turnId = null;
    this.emit('status', { id: state.id });
  }
}
