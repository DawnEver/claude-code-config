#!/usr/bin/env node
// scripts/bridge/daemon.mjs — the per-machine session bridge (docs/harness-architecture.md
// §5-7, docs/bridge.md).
//
// Owns the machine's single bot token and the only getUpdates loop, and multiplexes every
// live session on the machine: Codex threads via the shared app-server (codex-adapter.mjs)
// and Claude sessions via their session-bridge channel (channel-hub.mjs). Each session maps
// to (project group, Topic): project = origin repo name of the session cwd, group =
// `bridge.projects.<repo>.chatId` (else `bridge.fallbackChatId`), Topic title =
// `<machine>/<agent>/<branch>`. Telegram is a stateless view — the mapping is rebuilt from
// live sessions; topics.json only avoids re-creating a Topic after a restart.
//
// Inbound from allowlisted users only: plain text = inject; `/status`, `/interrupt`.
// Approvals: relayed as a notice. Inline accept/decline buttons appear only when this
// machine opts in (`bridge.approvalsFromTelegram: true`) and are honoured only for
// allowlisted user ids; anything else is dropped, not queued.

import fs from 'fs';
import path from 'path';
import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { TelegramClient } from './telegram.mjs';
import { CodexAdapter } from './codex-adapter.mjs';
import { ChannelHub } from './channel-hub.mjs';
import { readBridgeConfig, gitContext, writePrivateFile, BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './context.mjs';

const PROGRESS_MIN_INTERVAL_MS = 3000;

export class Bridge {
  /**
   * @param {{ telegram, codex?, hub?, config, machine: string,
   *           resolveContext?: (cwd, hints) => {project, branch},
   *           topicCacheFile?: string|null, log?: (msg) => void, now?: () => number }} deps
   */
  constructor({ telegram, codex = null, hub = null, config, machine, resolveContext = gitContext,
    topicCacheFile = null, log = () => {}, now = Date.now }) {
    Object.assign(this, { telegram, codex, hub, config, machine, resolveContext, topicCacheFile, log, now });
    this.sessions = new Map();   // key -> { agent, id, chatId, topicId, title, progress }
    this.approvals = new Map();  // short id -> { key, kind, ref, answerable }
    this.nextApproval = 1;
    this.topicCache = this.#loadCache();
    this.allowed = new Set(config.allowedUserIds);
    this.#wire();
  }

  #loadCache() {
    try { return JSON.parse(fs.readFileSync(this.topicCacheFile, 'utf8')); } catch { return {}; }
  }

  #saveCache() {
    if (!this.topicCacheFile) return;
    try { fs.mkdirSync(path.dirname(this.topicCacheFile), { recursive: true }); fs.writeFileSync(this.topicCacheFile, JSON.stringify(this.topicCache, null, 2)); } catch { /* cache only */ }
  }

  #wire() {
    const c = this.codex;
    if (c) {
      c.on('session-up', (s) => this.sessionUp('codex', s.threadId, s).catch((e) => this.log(`codex up: ${e.message}`)));
      c.on('session-down', (s) => this.sessionDown(`codex:${s.threadId}`));
      c.on('progress', (e) => this.progress(`codex:${e.threadId}`, e.text));
      c.on('final', (e) => this.final(`codex:${e.threadId}`, e.text, e.status));
      c.on('approval', (a) => this.approval(`codex:${a.threadId}`, { kind: 'codex', ref: a.key, summary: a.summary, answerable: a.answerable }));
      c.on('approval-resolved', (a) => this.approvalResolved('codex', a.key));
      c.on('warn', (m) => this.log(m));
    }
    const h = this.hub;
    if (h) {
      h.on('session-up', (s) => this.sessionUp('claude', s.sessionId, s).catch((e) => this.log(`claude up: ${e.message}`)));
      h.on('session-down', (s) => this.sessionDown(`claude:${s.sessionId}`));
      h.on('reply', (r) => this.final(`claude:${r.sessionId}`, r.text));
      h.on('permission', (p) => this.approval(`claude:${p.sessionId}`, {
        kind: 'claude', ref: p.request_id, answerable: true,
        summary: `${p.tool_name}: ${p.description ?? ''}${p.input_preview ? `\n${String(p.input_preview).slice(0, 1500)}` : ''}`,
      }));
    }
  }

  chatFor(project) {
    return this.config.projects[project]?.chatId ?? this.config.fallbackChatId ?? null;
  }

  async sessionUp(agent, id, { cwd, branch, originUrl } = {}) {
    const key = `${agent}:${id}`;
    if (this.sessions.has(key)) return this.sessions.get(key);
    const ctx = this.resolveContext(cwd, { branch, originUrl });
    const chatId = this.chatFor(ctx.project);
    const base = `${this.machine}/${agent}/${ctx.branch ?? 'detached'}`;
    const taken = new Set([...this.sessions.values()].filter((s) => s.chatId === chatId).map((s) => s.title));
    let title = base;
    for (let n = 2; taken.has(title); n++) title = `${base} #${n}`;
    const s = { agent, id, key, chatId, title, project: ctx.project, topicId: null, progress: null };
    this.sessions.set(key, s);
    if (chatId === null) { this.log(`no chat for project ${ctx.project}; ${key} not mirrored`); return s; }
    const cacheKey = `${chatId}|${title}`;
    s.topicId = this.topicCache[cacheKey] ?? null;
    if (!s.topicId) {
      try {
        s.topicId = (await this.telegram.createForumTopic(chatId, title)).message_thread_id;
        this.topicCache[cacheKey] = s.topicId;
        this.#saveCache();
      } catch (e) {
        this.log(`createForumTopic ${title}: ${e.message} (posting without a Topic)`);
      }
    }
    await this.#send(s, `session up: ${title}${ctx.project ? ` (${ctx.project})` : ''}`);
    return s;
  }

  sessionDown(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    this.#send(s, `session ended: ${s.title}`).catch(() => {});
  }

  async #send(s, text, opts = {}) {
    if (s.chatId === null) return [];
    try {
      return await this.telegram.sendMessage(s.chatId, text, { threadId: s.topicId ?? undefined, ...opts });
    } catch (e) {
      // A cached Topic that was deleted in Telegram: forget it, recreate on next restart.
      if (s.topicId && /thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(e.message)) {
        delete this.topicCache[`${s.chatId}|${s.title}`];
        this.#saveCache();
      }
      this.log(`send ${s.title}: ${e.message}`);
      return [];
    }
  }

  /** One progress message per turn, edited in place and throttled. */
  async progress(key, line) {
    const s = this.sessions.get(key);
    if (!s || s.chatId === null) return;
    const p = s.progress ??= { lines: [], msgId: null, last: 0, timer: null };
    p.lines.push(line);
    if (p.lines.length > 12) p.lines = p.lines.slice(-12);
    const flush = async () => {
      p.timer = null;
      p.last = this.now();
      const text = `working…\n${p.lines.join('\n')}`;
      if (p.msgId) {
        try { await this.telegram.editMessageText(s.chatId, p.msgId, text); } catch (e) { this.log(`edit: ${e.message}`); }
      } else {
        const [m] = await this.#send(s, text);
        p.msgId = m?.message_id ?? null;
      }
    };
    if (this.now() - p.last >= PROGRESS_MIN_INTERVAL_MS) return flush();
    if (!p.timer) { p.timer = setTimeout(flush, PROGRESS_MIN_INTERVAL_MS); p.timer.unref?.(); }
  }

  async final(key, text, status) {
    const s = this.sessions.get(key);
    if (!s) return;
    if (s.progress?.timer) clearTimeout(s.progress.timer);
    s.progress = null;
    const body = text?.trim() ? text : `(turn ${status ?? 'completed'}, no message)`;
    await this.#send(s, status && status !== 'completed' ? `[${status}] ${body}` : body);
  }

  async approval(key, { kind, ref, summary, answerable }) {
    const s = this.sessions.get(key);
    if (!s) return;
    const id = String(this.nextApproval++);
    this.approvals.set(id, { key, kind, ref });
    const offer = answerable && this.config.approvalsFromTelegram && this.allowed.size > 0;
    const head = offer ? `approval needed on ${this.machine}` : `approval needed on ${this.machine}, answer locally or via official remote`;
    const replyMarkup = offer ? { inline_keyboard: [[
      { text: 'Accept', callback_data: `ap:${id}:y` }, { text: 'Decline', callback_data: `ap:${id}:n` },
    ]] } : undefined;
    await this.#send(s, `${head}\n${summary}`, { replyMarkup });
  }

  approvalResolved(kind, ref) {
    for (const [id, a] of this.approvals) if (a.kind === kind && a.ref === ref) this.approvals.delete(id);
  }

  #sessionAt(chatId, topicId) {
    for (const s of this.sessions.values()) if (s.chatId === chatId && (s.topicId ?? null) === (topicId ?? null)) return s;
    return null;
  }

  /** Route one Telegram update. Senders outside the allowlist are dropped silently. */
  async handleUpdate(u) {
    if (u.callback_query) return this.#onCallback(u.callback_query);
    const m = u.message;
    if (!m?.text || !this.allowed.has(Number(m.from?.id))) return;
    const s = this.#sessionAt(m.chat.id, m.is_topic_message ? m.message_thread_id : null);
    if (!s) return;
    const text = m.text.trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*$/.exec(text)?.[1];
    if (cmd === 'status') return this.#send(s, `${s.title}: ${this.#status(s)}`);
    if (cmd === 'interrupt') {
      if (s.agent !== 'codex') return this.#send(s, 'interrupt is Codex-only; use Esc in the Claude TUI');
      const ok = await this.codex.interrupt(s.id).catch(() => false);
      return this.#send(s, ok ? 'interrupt sent' : 'nothing to interrupt');
    }
    try {
      if (s.agent === 'codex') await this.codex.inject(s.id, text);
      else if (!this.hub.deliver(s.id, text, m.from.username ?? String(m.from.id))) throw new Error('channel disconnected');
    } catch (e) {
      await this.#send(s, `inject failed: ${e.message}`);
    }
  }

  #status(s) {
    if (s.agent === 'codex') return this.codex?.status(s.id) ?? 'unknown';
    return this.hub?.sessions.has(s.id) ? 'channel connected' : 'channel disconnected';
  }

  async #onCallback(q) {
    const m = /^ap:(\d+):([yn])$/.exec(q.data ?? '');
    const allowed = this.config.approvalsFromTelegram && this.allowed.has(Number(q.from?.id));
    const a = m && this.approvals.get(m[1]);
    let note = 'not allowed';
    if (allowed && a) {
      const yes = m[2] === 'y';
      const s = this.sessions.get(a.key);
      const ok = a.kind === 'codex' ? this.codex?.answerApproval(a.ref, yes) : this.hub?.verdict(s?.id, a.ref, yes);
      this.approvals.delete(m[1]);
      note = ok ? (yes ? 'accepted' : 'declined') : 'already resolved';
      if (ok && q.message) this.telegram.editMessageText(q.message.chat.id, q.message.message_id, `${q.message.text ?? ''}\n-> ${note} by ${q.from.username ?? q.from.id}`).catch(() => {});
    } else if (allowed) note = 'already resolved';
    await this.telegram.answerCallbackQuery(q.id, note).catch(() => {});
  }

  /** Long-poll forever (until `signal` aborts). */
  async pollLoop(signal) {
    while (!signal?.aborted) {
      try {
        for (const u of await this.telegram.getUpdates({ signal })) await this.handleUpdate(u).catch((e) => this.log(`update: ${e.message}`));
      } catch (e) {
        if (signal?.aborted) break;
        this.log(`getUpdates: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

/** Keep the Codex adapter attached and its subscriptions current. */
async function codexLoop(codex, log, signal, everyMs = 15000) {
  while (!signal.aborted) {
    try {
      if (await codex.start()) await codex.refresh();
    } catch (e) { log(`codex: ${e.message}`); }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** pid of another live daemon from the runtime file, else null. */
export function runningDaemonPid(file = RUNTIME_FILE) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

export async function main() {
  const logIdx = process.argv.indexOf('--log');
  const logFile = logIdx > 0 ? process.argv[logIdx + 1] : null;
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = (m) => {
    const line = `[bridge ${new Date().toISOString()}] ${m}`;
    console.error(line);
    if (logFile) try { fs.appendFileSync(logFile, line + '\n'); } catch { /* best effort */ }
  };
  const other = runningDaemonPid();
  if (other) { log(`already running (pid ${other}); one getUpdates consumer per bot token`); process.exit(0); }
  const config = readBridgeConfig();
  const machine = readMachineName();
  if (!machine) { log('no machine name (~/.claude/machine.json); run setup.js --machine <NAME>'); process.exit(1); }
  if (!config.botToken) { log('no bridge.botToken in ~/.claude/claude_env_settings.local.json; see docs/bridge.md'); process.exit(1); }
  if (!config.allowedUserIds.length) log('bridge.allowedUserIds is empty: inbound Telegram messages will all be dropped');

  const telegram = new TelegramClient({ token: config.botToken, offsetFile: path.join(BRIDGE_RUNTIME_DIR, 'offset.json') });
  const hub = new ChannelHub();
  const port = await hub.listen(0);
  writePrivateFile(RUNTIME_FILE, JSON.stringify({ port, token: hub.token, pid: process.pid }, null, 2));
  const codex = new CodexAdapter();
  const bridge = new Bridge({ telegram, codex, hub, config, machine, log, topicCacheFile: path.join(BRIDGE_RUNTIME_DIR, 'topics.json') });

  const ac = new AbortController();
  const stop = () => {
    ac.abort();
    try { if (JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).pid === process.pid) fs.rmSync(RUNTIME_FILE); } catch { /* gone */ }
    codex.stop();
    hub.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(`up: machine=${machine} ipc=127.0.0.1:${port}`);
  codexLoop(codex, log, ac.signal);
  await bridge.pollLoop(ac.signal);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
