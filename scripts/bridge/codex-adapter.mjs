// scripts/bridge/codex-adapter.mjs — the bridge as one more client of the shared Codex
// app-server daemon (docs/harness-architecture.md §4, §11).
//
// Transport: `codex app-server proxy` relays stdio to the daemon's control socket, and the
// socket speaks WebSocket (see ws-stream.mjs), so JSON-RPC messages ride text frames.
// Liveness is probed with `codex app-server daemon version` — never by the socket file,
// which survives a dead daemon.
//
// Live sessions = `thread/loaded/list` (threads the daemon holds in memory). Each is
// subscribed with `thread/resume`, which only works for persisted (non-ephemeral) threads.
// Emits the host-neutral events documented in daemon.mjs.
//
// Method names verified against `codex app-server generate-json-schema` (codex-cli 0.159.3).

import { EventEmitter } from 'events';
import { spawn, execFile } from 'child_process';
import { WsStreamClient } from './ws-stream.mjs';
import { JsonRpcPeer } from './jsonrpc.mjs';

const QUOTA_REFRESH_MS = 5 * 60000;
const isCodexBucket = (l) => Boolean(l) && (l.limitId ?? 'codex') === 'codex';
const dropNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const IS_WIN = process.platform === 'win32';

/** Approval requests whose response is `{ decision: 'accept' | 'decline' }`. */
export const ANSWERABLE_APPROVALS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const APPROVAL_RE = /requestApproval$|^(applyPatchApproval|execCommandApproval)$/;

/** Spawn `codex <args>`; Windows needs a shell to resolve the npm `.cmd` shim. */
function spawnCodex(args, opts = {}) {
  return IS_WIN
    ? spawn(['codex', ...args].join(' '), { shell: true, windowsHide: true, ...opts })
    : spawn('codex', args, opts);
}

export function probeDaemon() {
  return new Promise((resolve) => {
    const cmd = IS_WIN ? 'codex app-server daemon version' : 'codex';
    const args = IS_WIN ? [] : ['app-server', 'daemon', 'version'];
    execFile(cmd, args, { shell: IS_WIN, windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const v = JSON.parse(stdout);
        resolve(v.status === 'running' ? v : null);
      } catch { resolve(null); }
    });
  });
}

/** Default connector: proxy child + WebSocket framing. Returns a message transport. */
export function connectProxy() {
  const child = spawnCodex(['app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ws = new WsStreamClient(child.stdout, child.stdin);
  child.on('exit', () => ws.emit('close'));
  return {
    onOpen: (fn) => ws.once('open', fn),
    onMessage: (fn) => ws.on('message', fn),
    onClose: (fn) => ws.once('close', fn),
    send: (t) => ws.send(t),
    close: () => { ws.close(); child.kill(); },
  };
}

function oneLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Compact progress line for a completed item, or null for items not worth a line. */
export function progressLine(item) {
  switch (item?.type) {
    case 'commandExecution': return null; // Commands/output stay local; approvals are separate.
    case 'fileChange': {
      const n = Array.isArray(item.changes) ? item.changes.length : 0;
      return `edited ${n || 'some'} file${n === 1 ? '' : 's'}`;
    }
    case 'mcpToolCall': return `tool ${item.server ?? ''}/${item.tool ?? ''}`.trim();
    case 'webSearch': return `search ${oneLine(item.query, 80)}`;
    default: return null;
  }
}

const promptText = (item) => (item.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();

/** Native item order and IDs are authoritative; never collapse an answer to its last item. */
function finalText(items = []) {
  const messages = new Map();
  for (const item of items) {
    if (item?.type !== 'agentMessage') continue;
    messages.set(item.id ?? Symbol(), item);
  }
  const all = [...messages.values()];
  const hasFinalPhase = all.some((item) => item.phase === 'final_answer');
  return all.filter((item) => hasFinalPhase ? item.phase === 'final_answer' : item.phase !== 'commentary')
    .map((item) => item.text ?? '').filter((text) => text.trim()).join('\n\n');
}

/**
 * Turns a session ran before the bridge subscribed to it — the opening prompt of a fresh
 * thread lands before the next poll. Only turns that started after the bridge connected
 * count, so a bridge restart never replays a thread's whole history.
 * @returns {{kind: 'prompt'|'final', text: string, status?: string, turnId: string|null}[]}
 */
export function backlogSince(turns = [], sinceMs) {
  const out = [];
  for (const t of turns) {
    if (!t?.startedAt || t.startedAt * 1000 < sinceMs) continue;
    for (const item of t.items ?? []) {
      if (item.type === 'userMessage') { const text = promptText(item); if (text) out.push({ kind: 'prompt', text, turnId: t.id ?? null }); }
    }
    if (t.status !== 'inProgress') out.push({ kind: 'final', text: finalText(t.items), status: t.status, turnId: t.id ?? null });
  }
  return out;
}

/**
 * Only main sessions are bridged: not a subagent (`parentThreadId`, `source.subAgent` —
 * review, compact, memory_consolidation, thread_spawn), not `codex exec` (automated, e.g.
 * fabric or sharp-review reviewers). A user fork (`forkedFromId`, no parent) is main.
 */
export function isMainSession(thread) {
  const src = thread?.source;
  return !thread?.parentThreadId && !(src && typeof src === 'object' && 'subAgent' in src) && src !== 'exec';
}

export class CodexAdapter extends EventEmitter {
  constructor({ connect = connectProxy, probe = probeDaemon, clientName = 'cc-config-bridge', now = Date.now, resumeRetryMs = 3000 } = {}) {
    super();
    this.agent = 'codex';
    this.now = now;
    this.resumeRetryMs = resumeRetryMs;
    this.connectedAt = Infinity;
    this.pending = new Set();
    this.skipped = new Set();    // ephemeral or non-main threads: never subscribed
    this.connect = connect;
    this.probe = probe;
    this.clientName = clientName;
    this.rpc = null;
    this.connection = 0;
    this.threads = new Map();     // threadId -> { cwd, branch, activeTurnId, agentMessages }
    this.approvals = new Map();   // key -> { rpcId, method, threadId }
    this.quota = null;            // { limits: RateLimitSnapshot, at } for the fleet report (fleet.mjs)
    this.account = null;          // { email, plan } of the ChatGPT login, for the same report
  }

  /** Attach to the daemon. Resolves false (no throw) when it is not running. */
  async start() {
    if (this.rpc) return true;
    if (!(await this.probe())) return false;
    const connection = ++this.connection;
    const t = this.connect();
    const rpc = new JsonRpcPeer((s) => t.send(s), {
      onRequest: (m, p, id) => { if (this.rpc === rpc) return this.#onServerRequest(m, p, id); },
      onNotification: (m, p) => { if (this.rpc === rpc) this.#onNotification(m, p); },
    });
    t.onMessage((s) => rpc.receive(s));
    t.onClose(() => {
      rpc.failAll();
      if (this.rpc !== rpc) return;
      this.rpc = null;
      this.quota = null;   // a dead feed must not look fresh
      this.account = null;
      for (const id of [...this.threads.keys()]) this.#drop(id);
      this.pending.clear();
      this.skipped.clear();
    });
    await new Promise((resolve) => t.onOpen(resolve));
    await rpc.request('initialize', { clientInfo: { name: this.clientName, version: '1' } });
    if (connection !== this.connection) return false;
    rpc.notify('initialized');
    this.rpc = rpc;
    this.transport = t;
    this.connectedAt = this.now();
    return true;
  }

  stop() { this.transport?.close(); }

  /** Reconcile subscriptions with the daemon's loaded threads. */
  async refresh() {
    if (!this.rpc) return;
    // Account quota: pushed on change, re-read every few minutes as a backstop.
    if (!this.quota || this.now() - this.quota.at >= QUOTA_REFRESH_MS) {
      const a = (await this.rpc.request('account/read', {}).catch(() => null))?.account;
      this.account = a?.type === 'chatgpt' ? { email: a.email ?? null, plan: a.planType ?? null } : a ? { email: null, plan: a.type } : null;
      const r = await this.rpc.request('account/rateLimits/read', {}).catch(() => null);
      if (isCodexBucket(r?.rateLimits)) this.quota = { limits: r.rateLimits, at: this.now() };
    }
    const ids = new Set();
    let cursor = null;
    do {
      const r = await this.rpc.request('thread/loaded/list', cursor ? { cursor } : {});
      for (const id of r.data ?? []) ids.add(id);
      cursor = r.nextCursor;
    } while (cursor);
    for (const id of [...this.threads.keys()]) if (!ids.has(id)) this.#drop(id);
    for (const id of ids) if (!this.threads.has(id)) await this.#subscribe(id).catch((e) => this.emit('warn', `resume ${id}: ${e.message}`));
  }

  async #subscribe(threadId) {
    // thread/started and the poll can race for the same thread; resume it once.
    if (!this.rpc || this.threads.has(threadId) || this.pending.has(threadId) || this.skipped.has(threadId)) return;
    const connection = this.connection;
    this.pending.add(threadId);
    try {
      await this.#resume(threadId);
    } catch (e) {
      if (connection !== this.connection || !this.rpc) return;
      if (!/no rollout found|rollout at .* is empty/i.test(e.message)) throw e;
      // No rollout yet is normal for a fresh thread: Codex writes it once the first turn
      // starts, so retry shortly (the poll is the backstop). An ephemeral thread never gets
      // one, so it is skipped for good instead of failing every poll.
      // thread/read fails too before the rollout exists, so only an explicit `ephemeral`
      // answer gives up; anything else is retried.
      const read = await this.rpc?.request('thread/read', { threadId }).catch(() => null);
      if (read?.thread?.ephemeral === true) { this.skipped.add(threadId); return; }
      const t = setTimeout(() => {
        if (connection === this.connection && this.rpc) this.#subscribe(threadId).catch((err) => this.emit('warn', `resume ${threadId}: ${err.message}`));
      }, this.resumeRetryMs);
      t.unref?.();
    } finally { if (connection === this.connection) this.pending.delete(threadId); }
  }

  async #resume(threadId) {
    const rpc = this.rpc;
    if (!rpc) return;
    const r = await rpc.request('thread/resume', { threadId });
    if (this.rpc !== rpc) return;
    const th = r.thread ?? {};
    if (th.ephemeral) return;
    if (!isMainSession(th)) { this.#dismiss(threadId); return; }
    const running = (th.turns ?? []).findLast?.((t) => t.status === 'inProgress');
    const info = {
      cwd: th.cwd ?? r.cwd,
      branch: th.gitInfo?.branch ?? null,
      activeTurnId: running?.id ?? null,
      agentMessages: new Map((running?.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => [item.id, item])),
    };
    this.threads.set(threadId, info);
    this.emit('up', { id: threadId, cwd: info.cwd, branch: info.branch, backlog: backlogSince(th.turns, this.connectedAt) });
  }

  /** A non-main thread: never subscribed again; `dismiss` lets the daemon close any Topic it has. */
  #dismiss(threadId) {
    if (this.skipped.has(threadId)) return;
    this.skipped.add(threadId);
    this.emit('dismiss', { id: threadId });
  }

  #drop(threadId) {
    for (const [key, a] of this.approvals) {
      if (a.threadId !== threadId) continue;
      this.approvals.delete(key);
      this.emit('approval-resolved', { ref: key });
    }
    if (!this.threads.delete(threadId)) return;
    this.emit('down', { id: threadId });
  }

  #onNotification(method, p = {}) {
    const th = this.threads.get(p.threadId);
    switch (method) {
      case 'account/rateLimits/updated':
        // A push may carry only the windows that changed: keep the others.
        if (isCodexBucket(p.rateLimits)) this.quota = { limits: { ...this.quota?.limits, ...dropNulls(p.rateLimits) }, at: this.now() };
        break;
      case 'turn/started':
        if (th) {
          th.activeTurnId = p.turn?.id ?? null; th.agentMessages.clear();
          this.emit('status', { id: p.threadId });
        }
        break;
      case 'item/started':
        if (th && p.item?.type === 'agentMessage' && (!th.activeTurnId || !p.turnId || th.activeTurnId === p.turnId))
          th.agentMessages.set(p.item.id, { ...th.agentMessages.get(p.item.id), ...p.item });
        break;
      case 'item/agentMessage/delta':
        if (th && (!th.activeTurnId || !p.turnId || th.activeTurnId === p.turnId)) {
          const previous = th.agentMessages.get(p.itemId);
          th.agentMessages.set(p.itemId, { ...previous, id: p.itemId, type: 'agentMessage', text: (previous?.text ?? '') + (p.delta ?? '') });
        }
        break;
      case 'item/completed': {
        const item = p.item ?? {};
        if (item.type === 'userMessage') {
          const text = promptText(item);
          if (text) this.emit('prompt', { id: p.threadId, turnId: p.turnId ?? null, text });
        }
        if (item.type === 'agentMessage' && th && (!th.activeTurnId || !p.turnId || th.activeTurnId === p.turnId)) {
          const previous = th.agentMessages.get(item.id);
          th.agentMessages.set(item.id, { ...previous, ...item, text: item.text ?? previous?.text ?? '' });
        }
        const line = progressLine(item);
        if (line) this.emit('progress', { id: p.threadId, text: line });
        break;
      }
      case 'turn/completed': {
        if (th?.activeTurnId && p.turn?.id && th.activeTurnId !== p.turn.id) break;
        const status = p.turn?.status;
        const snapshot = (p.turn?.items ?? []).filter((item) => item.type === 'agentMessage');
        const ids = new Set(snapshot.map((item) => item.id));
        // A completed snapshot repairs missed notifications and wins over partial deltas.
        const items = [...snapshot, ...[...(th?.agentMessages.values() ?? [])].filter((item) => !ids.has(item.id))];
        const text = finalText(items);
        if (th) { th.activeTurnId = null; th.agentMessages.clear(); }
        this.emit('final', { id: p.threadId, turnId: p.turn?.id ?? null, status, text });
        if (th) this.emit('status', { id: p.threadId });
        break;
      }
      case 'serverRequest/resolved': {
        for (const [key, a] of this.approvals) {
          if (String(a.rpcId) === String(p.requestId) && (!p.threadId || a.threadId === p.threadId)) {
              this.approvals.delete(key);
              this.emit('approval-resolved', { ref: key });
              this.emit('status', { id: a.threadId });
          }
        }
        break;
      }
      case 'thread/started': {
        // Subscribe at once instead of waiting for the next poll; the backlog covers any
        // turn that still slipped in first.
        const id = p.thread?.id;
        if (id && !isMainSession(p.thread)) { this.#dismiss(id); break; }
        if (id && !this.threads.has(id) && !p.thread.ephemeral) {
          this.#subscribe(id).catch((e) => this.emit('warn', `resume ${id}: ${e.message}`));
        }
        break;
      }
      case 'thread/closed': this.#drop(p.threadId); break;
      default: break;
    }
  }

  /** Server->client requests. Approvals are relayed, never auto-answered. */
  #onServerRequest(method, p = {}, rpcId) {
    if (!APPROVAL_RE.test(method)) return undefined;   // leave for the TUI (first answer wins)
    const threadId = p.threadId ?? p.conversationId;
    if (!this.threads.has(threadId)) return undefined;
    const key = `c${this.connection}:${rpcId}`;
    if (this.approvals.has(key)) return undefined;
    this.approvals.set(key, { rpcId, method, threadId: p.threadId ?? p.conversationId });
    const summary = p.command ? `$ ${oneLine(Array.isArray(p.command) ? p.command.join(' ') : p.command, 300)}`
      : p.reason ? oneLine(p.reason, 300) : method;
    this.emit('approval', {
      id: p.threadId ?? p.conversationId, ref: key, summary,
      answerable: ANSWERABLE_APPROVALS.has(method),
    });
    this.emit('status', { id: threadId });
    return undefined;   // answered later via answerApproval, or by another client
  }

  /** Answer a pending approval. Only call this behind the allowlist opt-in. */
  answerApproval(key, accept) {
    const a = this.approvals.get(key);
    if (!a || a.submitted || !this.rpc || !ANSWERABLE_APPROVALS.has(a.method)) return false;
    a.submitted = true; // Submission is not native resolution; do not replay on uncertainty.
    this.rpc.respond(a.rpcId, { decision: accept ? 'accept' : 'decline' });
    return true;
  }

  /** Inject user text: `turn/steer` mid-turn, `turn/start` when idle. */
  async inject(threadId, text, _user, { images = [] } = {}) {
    if (!this.rpc) throw new Error('codex app-server not connected');
    const th = this.threads.get(threadId);
    if (!th) throw new Error('codex thread not loaded');
    const rpc = this.rpc;
    const input = [{ type: 'text', text, text_elements: [] }];
    for (const imagePath of images) input.push({ type: 'localImage', path: imagePath });
    if (th?.activeTurnId) {
      await rpc.request('turn/steer', { threadId, expectedTurnId: th.activeTurnId, input });
      return 'steered';
    }
    const r = await rpc.request('turn/start', { threadId, input });
    if (this.rpc === rpc && this.threads.get(threadId) === th && r?.turn?.id) th.activeTurnId = r.turn.id;
    return 'started';
  }

  async interrupt(threadId) {
    const th = this.threads.get(threadId);
    if (!this.rpc || !th?.activeTurnId) return false;
    await this.rpc.request('turn/interrupt', { threadId, turnId: th.activeTurnId });
    return true;
  }

  status(threadId) {
    const th = this.threads.get(threadId);
    if (!th) return 'not loaded';
    return th.activeTurnId ? `turn in progress (${th.activeTurnId})` : 'idle';
  }

  /** Structured projection of native connection, turn and unresolved approval records. */
  statusSnapshot(threadId) {
    const th = this.threads.get(threadId);
    let state = 'disconnected';
    if (this.rpc && th) {
      const waiting = [...this.approvals.values()].some((approval) => approval.threadId === threadId);
      state = waiting ? 'waiting-approval' : th.activeTurnId ? 'running' : 'idle';
    }
    return { state };
  }
}
