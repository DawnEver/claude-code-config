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
// `thread/list` is the metadata fallback when `thread/read` does not answer.
//
// Method names verified against `codex app-server generate-json-schema` (codex-cli 0.159.3).

import { EventEmitter } from 'events';
import { spawn, execFile } from 'child_process';
import { WsStreamClient } from './ws-stream.mjs';
import { JsonRpcPeer } from './jsonrpc.mjs';

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
    case 'commandExecution': {
      const code = item.exitCode ?? item.exit_code;
      return `$ ${oneLine(item.command, 120)}${code !== undefined && code !== null ? ` (exit ${code})` : ''}`;
    }
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

/**
 * Turns a session ran before the bridge subscribed to it — the opening prompt of a fresh
 * thread lands before the next poll. Only turns that started after the bridge connected
 * count, so a bridge restart never replays a thread's whole history.
 * @returns {{kind: 'prompt'|'final', text: string, status?: string}[]}
 */
export function backlogSince(turns = [], sinceMs) {
  const out = [];
  for (const t of turns) {
    if (!t?.startedAt || t.startedAt * 1000 < sinceMs) continue;
    let agent = null;
    for (const item of t.items ?? []) {
      if (item.type === 'userMessage') { const text = promptText(item); if (text) out.push({ kind: 'prompt', text }); }
      if (item.type === 'agentMessage' && item.text) agent = item.text;
    }
    if (t.status !== 'inProgress') out.push({ kind: 'final', text: agent ?? '', status: t.status });
  }
  return out;
}

export class CodexAdapter extends EventEmitter {
  constructor({ connect = connectProxy, probe = probeDaemon, clientName = 'cc-config-bridge', now = Date.now } = {}) {
    super();
    this.now = now;
    this.connectedAt = Infinity;
    this.pending = new Set();
    this.connect = connect;
    this.probe = probe;
    this.clientName = clientName;
    this.rpc = null;
    this.threads = new Map();     // threadId -> { cwd, branch, name, activeTurnId, deltas, lastAgent }
    this.approvals = new Map();   // key -> { rpcId, method, threadId }
  }

  get connected() { return !!this.rpc; }

  /** Attach to the daemon. Resolves false (no throw) when it is not running. */
  async start() {
    if (this.rpc) return true;
    if (!(await this.probe())) return false;
    const t = this.connect();
    const rpc = new JsonRpcPeer((s) => t.send(s), {
      onRequest: (m, p, id) => this.#onServerRequest(m, p, id),
      onNotification: (m, p) => this.#onNotification(m, p),
    });
    t.onMessage((s) => rpc.receive(s));
    t.onClose(() => {
      rpc.failAll();
      if (this.rpc !== rpc) return;
      this.rpc = null;
      for (const id of [...this.threads.keys()]) this.#drop(id);
      this.emit('disconnected');
    });
    await new Promise((resolve) => t.onOpen(resolve));
    await rpc.request('initialize', { clientInfo: { name: this.clientName, version: '1' } });
    rpc.notify('initialized');
    this.rpc = rpc;
    this.transport = t;
    this.connectedAt = this.now();
    this.synced = false;
    return true;
  }

  stop() { this.transport?.close(); }

  /** Reconcile subscriptions with the daemon's loaded threads. */
  async refresh() {
    if (!this.rpc) return;
    const ids = new Set();
    let cursor = null;
    do {
      const r = await this.rpc.request('thread/loaded/list', cursor ? { cursor } : {});
      for (const id of r.data ?? []) ids.add(id);
      cursor = r.nextCursor;
    } while (cursor);
    for (const id of [...this.threads.keys()]) if (!ids.has(id)) this.#drop(id);
    // Threads already loaded at the first sync are mostly idle leftovers of exited TUIs.
    const preexisting = !this.synced;
    for (const id of ids) if (!this.threads.has(id)) await this.#subscribe(id, { preexisting }).catch((e) => this.emit('warn', `resume ${id}: ${e.message}`));
    this.synced = true;
  }

  async #subscribe(threadId, opts = {}) {
    // thread/started and the poll can race for the same thread; resume it once.
    if (this.threads.has(threadId) || this.pending.has(threadId)) return;
    this.pending.add(threadId);
    try { await this.#resume(threadId, opts); } finally { this.pending.delete(threadId); }
  }

  async #resume(threadId, { preexisting = false } = {}) {
    const r = await this.rpc.request('thread/resume', { threadId });
    const th = r.thread ?? {};
    if (th.ephemeral) return;
    const running = (th.turns ?? []).findLast?.((t) => t.status === 'inProgress');
    const info = {
      cwd: th.cwd ?? r.cwd,
      branch: th.gitInfo?.branch ?? null,
      name: th.name ?? th.preview ?? null,
      activeTurnId: running?.id ?? null,
      deltas: new Map(),
      lastAgent: null,
    };
    this.threads.set(threadId, info);
    this.emit('session-up', { threadId, cwd: info.cwd, branch: info.branch, name: info.name,
      preexisting, backlog: backlogSince(th.turns, this.connectedAt) });
  }

  #drop(threadId) {
    if (!this.threads.delete(threadId)) return;
    this.emit('session-down', { threadId });
  }

  #onNotification(method, p = {}) {
    const th = this.threads.get(p.threadId);
    switch (method) {
      case 'turn/started':
        if (th) { th.activeTurnId = p.turn?.id ?? null; th.lastAgent = null; }
        this.emit('turn-started', { threadId: p.threadId, turnId: p.turn?.id });
        break;
      case 'item/agentMessage/delta':
        if (th) th.deltas.set(p.itemId, (th.deltas.get(p.itemId) ?? '') + (p.delta ?? ''));
        break;
      case 'item/completed': {
        const item = p.item ?? {};
        if (item.type === 'userMessage') {
          const text = promptText(item);
          if (text) this.emit('prompt', { threadId: p.threadId, text });
        }
        if (item.type === 'agentMessage' && th) {
          th.lastAgent = item.text ?? th.deltas.get(item.id) ?? th.lastAgent;
          th.deltas.delete(item.id);
        }
        const line = progressLine(item);
        if (line) this.emit('progress', { threadId: p.threadId, text: line });
        break;
      }
      case 'turn/completed': {
        const status = p.turn?.status;
        let text = th?.lastAgent;
        if (!text && th?.deltas.size) text = [...th.deltas.values()].join('\n');
        if (th) { th.activeTurnId = null; th.deltas.clear(); th.lastAgent = null; }
        this.emit('final', { threadId: p.threadId, status, text: text ?? '' });
        break;
      }
      case 'serverRequest/resolved': {
        for (const [key, a] of this.approvals) {
          if (String(a.rpcId) === String(p.requestId)) {
            this.approvals.delete(key);
            this.emit('approval-resolved', { key, threadId: a.threadId });
          }
        }
        break;
      }
      case 'thread/started': {
        // Subscribe at once instead of waiting for the next poll; the backlog covers any
        // turn that still slipped in first.
        const id = p.thread?.id;
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
    const key = `c${rpcId}`;
    this.approvals.set(key, { rpcId, method, threadId: p.threadId ?? p.conversationId });
    const summary = p.command ? `$ ${oneLine(Array.isArray(p.command) ? p.command.join(' ') : p.command, 300)}`
      : p.reason ? oneLine(p.reason, 300) : method;
    this.emit('approval', {
      key, threadId: p.threadId ?? p.conversationId, method, summary,
      answerable: ANSWERABLE_APPROVALS.has(method),
    });
    return undefined;   // answered later via answerApproval, or by another client
  }

  /** Answer a pending approval. Only call this behind the allowlist opt-in. */
  answerApproval(key, accept) {
    const a = this.approvals.get(key);
    if (!a || !this.rpc || !ANSWERABLE_APPROVALS.has(a.method)) return false;
    this.approvals.delete(key);
    this.rpc.respond(a.rpcId, { decision: accept ? 'accept' : 'decline' });
    return true;
  }

  /** Inject user text: `turn/steer` mid-turn, `turn/start` when idle. */
  async inject(threadId, text) {
    if (!this.rpc) throw new Error('codex app-server not connected');
    const th = this.threads.get(threadId);
    const input = [{ type: 'text', text, text_elements: [] }];
    if (th?.activeTurnId) {
      try {
        await this.rpc.request('turn/steer', { threadId, expectedTurnId: th.activeTurnId, input });
        return 'steered';
      } catch {
        th.activeTurnId = null;   // turn ended under us: fall through to a fresh turn
      }
    }
    const r = await this.rpc.request('turn/start', { threadId, input });
    if (th && r?.turn?.id) th.activeTurnId = r.turn.id;
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
}
