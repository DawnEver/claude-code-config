#!/usr/bin/env node
// scripts/bridge/daemon.mjs — the per-machine session bridge (docs/bridge.md).
//
// Owns the machine's single bot token and the only getUpdates loop, and multiplexes every
// live session on the machine. Host specifics live in adapters (codex-adapter.mjs,
// claude-adapter.mjs), which all emit the same events:
//   up {id, cwd, branch?, preexisting, backlog[]}, prompt {id, text, turnId?},
//   progress {id, text}, final {id, text, turnId?, status?},
//   approval {id, ref, summary, answerable}, approval-resolved {ref}, down {id}
// and offer the same interface: inject(id, text, user), status(id),
// answerApproval(ref, allow, id), and optionally interrupt(id).
// This file is host-agnostic: one lifecycle (lifecycle.mjs), one ordered write queue per
// session, one bring-up hold, one echo suppression.
//
// Inbound from allowlisted users only: plain text = inject; `/status`, `/interrupt`.
// Approval buttons only when this machine opts in, honoured only for allowlisted ids.

import fs from 'fs';
import path from 'path';
import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { TelegramClient } from './telegram.mjs';
import { CodexAdapter } from './codex-adapter.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { TopicCache } from './topic-cache.mjs';
import { Observer } from './observer.mjs';
import { newSession, onUp, onActivity, onIdleTick, onDown, onDismiss, onTopicGone, onTopicFoundClosed, cacheEntry } from './lifecycle.mjs';
import { readBridgeConfig, gitContext, writePrivateFile, BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './context.mjs';

const PROGRESS_MIN_INTERVAL_MS = 3000;
const PROGRESS_LINES = 12;
const ECHO_TTL_MS = 10 * 60000;   // a Telegram inject that never echoes back is forgotten
const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i;
const TOPIC_CLOSED = /TOPIC_CLOSED/i;
const TOPIC_UNCHANGED = /TOPIC_NOT_MODIFIED/i;

export const sessionKey = (agent, id) => `${agent}:${id}`;
export const topicTitle = (machine, agent, branch) => `${machine}/${agent}/${branch ?? 'detached'}`;

export class Bridge {
  /**
   * @param {{ telegram, adapters?: EventEmitter[], config, machine: string,
   *           resolveContext?: (cwd, hints) => {project, branch},
   *           topicCacheFile?: string|null, log?: (msg) => void, now?: () => number }} deps
   */
  constructor({ telegram, adapters = [], config, machine, resolveContext = gitContext,
    topicCacheFile = null, log = () => {}, now = Date.now }) {
    Object.assign(this, { telegram, config, machine, resolveContext, log, now });
    this.hosts = new Map(adapters.map((a) => [a.agent, a]));
    this.sessions = new Map();   // key -> session (lifecycle.mjs record + routing fields)
    this.held = new Map();       // key -> live events that arrived during bring-up
    this.approvals = new Map();  // short id -> { key, agent, ref }
    this.nextApproval = 1;
    this.topics = new TopicCache(topicCacheFile);
    this.allowed = new Set(config.allowedUserIds);
    this.warned = new Map();     // what -> last logged message (log each distinct failure once)
    for (const a of adapters) this.#wire(a);
  }

  #wire(a) {
    a.on('up', (e) => this.sessionUp(a.agent, e).catch((err) => this.log(`${a.agent} up: ${err.message}`)));
    a.on('down', (e) => this.sessionDown(sessionKey(a.agent, e.id)));
    a.on('dismiss', (e) => this.dismiss(sessionKey(a.agent, e.id)));
    for (const kind of ['prompt', 'progress', 'final', 'approval']) {
      a.on(kind, (e) => {
        const key = sessionKey(a.agent, e.id);
        const q = this.held.get(key);
        if (q) q.push({ kind, e }); else this.#event(key, kind, e).catch((err) => this.log(`${kind}: ${err.message}`));
      });
    }
    a.on('approval-resolved', (e) => {
      for (const [id, x] of this.approvals) if (x.agent === a.agent && x.ref === e.ref) this.approvals.delete(id);
    });
    a.on('warn', (m) => this.log(m));
  }

  #event(key, kind, e) {
    if (kind === 'prompt') return this.prompt(key, e.text);
    if (kind === 'progress') return this.progress(key, e.text);
    if (kind === 'final') return this.final(key, e.text, e.status);
    return this.approval(key, e);
  }

  chatFor(project) {
    return this.config.projects[project]?.chatId ?? this.config.fallbackChatId ?? null;
  }

  /**
   * Register a session, replay its backlog, then release the live events held meanwhile,
   * minus the turns the backlog already carried (a turn that completes during bring-up is
   * reported both ways).
   */
  async sessionUp(agent, { id, cwd, branch, preexisting = false, backlog = [] }) {
    const key = sessionKey(agent, id);
    if (this.sessions.has(key) || this.held.has(key)) return this.sessions.get(key);
    this.held.set(key, []);
    try {
      const ctx = this.resolveContext(cwd, { branch });
      const chatId = this.chatFor(ctx.project);
      const cached = chatId === null ? null : this.topics.get(TopicCache.key(chatId, key));
      const base = topicTitle(this.machine, agent, ctx.branch);
      const s = { ...newSession({ key, cached, now: this.now() }), agent, id, chatId, base,
        title: cached?.title ?? base, project: ctx.project, cwd, chain: Promise.resolve(), progress: null, injected: [] };
      this.sessions.set(key, s);
      this.log(`up ${key} project=${ctx.project} branch=${ctx.branch} preexisting=${preexisting} topic=${s.topicId ?? '-'}`);
      if (chatId === null) this.log(`no chat for project ${ctx.project}; ${key} not mirrored`);
      else await this.#apply(s, onUp(s, { preexisting, now: this.now() }));
      for (const b of backlog) await this.#event(key, b.kind, b);
    } finally {
      const seen = new Set(backlog.filter((b) => b.turnId).map((b) => `${b.kind}:${b.turnId}`));
      const q = this.held.get(key) ?? [];
      this.held.delete(key);
      for (const { kind, e } of q) if (!(e.turnId && seen.has(`${kind}:${e.turnId}`))) await this.#event(key, kind, e).catch(() => {});
    }
    return this.sessions.get(key);
  }

  // ── coordination view (observer.mjs) ──

  /** Main sessions the observer watches: their repo is found from the cwd. */
  observedSessions() {
    return [...this.sessions.values()].filter((s) => this.hosts.has(s.agent))
      .map(({ key, cwd, chatId, project }) => ({ key, cwd, chatId, project }));
  }

  /** Post into a registered session's Topic (same lifecycle as its own output). */
  notify(key, text) {
    const s = this.sessions.get(key);
    return s ? this.#send(s, text) : Promise.resolve([]);
  }

  /** Post into the project group's `lanes` Topic: a session of its own, never ended. */
  postLanes(chatId, project, text) {
    const key = sessionKey('lanes', project);
    let s = this.sessions.get(key);
    if (!s) {
      const cached = this.topics.get(TopicCache.key(chatId, key));
      s = { ...newSession({ key, cached, now: this.now() }), agent: 'lanes', id: project, chatId, base: 'lanes',
        title: cached?.title ?? 'lanes', project, cwd: null, chain: Promise.resolve(), progress: null, injected: [] };
      this.sessions.set(key, s);
    }
    return this.#send(s, text);
  }

  sessionDown(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    this.log(`down ${key}`);
    if (s.chatId !== null) this.#apply(s, onDown(s, this.now())).catch(() => {});
  }

  /**
   * A host found this session is not a main session (subagent, automated run): it is never
   * registered, and a Topic it got before that was known is closed quietly, then ages out.
   */
  dismiss(key) {
    this.log(`skip ${key}: not a main session`);
    for (const [k, cached] of Object.entries(this.topics.entries)) {
      if (!k.endsWith(`|${key}`)) continue;
      const s = { ...newSession({ key, cached, now: this.now() }), chatId: TopicCache.chatIdOf(k), title: cached.title ?? key, chain: Promise.resolve() };
      this.#apply(s, onDismiss(s, this.now())).catch(() => {});
    }
  }

  /** Close the Topics of sessions idle for `idleCloseMinutes`; the session stays registered. */
  closeIdle() {
    const runs = [];
    for (const s of this.sessions.values()) {
      if (s.chatId === null) continue;
      const actions = onIdleTick(s, this.now(), this.config.idleCloseMinutes);
      if (actions.length) runs.push(this.#apply(s, actions));
    }
    return Promise.all(runs).then(() => runs.length);
  }

  /**
   * Delete Topics closed more than `deleteClosedAfterHours` ago. A Topic held by a
   * registered session is never deleted: an idle-closed session may come back.
   */
  async sweepClosedTopics() {
    let n = 0;
    const holder = (k) => [...this.sessions.values()].find((s) => s.chatId !== null && TopicCache.key(s.chatId, s.key) === k);
    for (const [k, e] of this.topics.due(this.now(), this.config.deleteClosedAfterHours)) {
      if (holder(k)) continue;
      try {
        await this.telegram.deleteForumTopic(TopicCache.chatIdOf(k), e.topicId);
      } catch (err) {
        if (!TOPIC_GONE.test(err.message)) { this.#warnOnce('deleteForumTopic', `${err.message} (needs the "Delete messages" right; kept for the next sweep)`); continue; }
      }
      this.warned.delete('deleteForumTopic');
      if (this.topics.get(k) === e) this.topics.set(k, null);
      const h = holder(k);   // re-attached while the delete was in flight
      if (h?.topicId === e.topicId) Object.assign(h, { topicId: null, state: 'none', closedAt: null });
      n++;
      this.log(`deleted closed topic ${e.title ?? k} [topic ${e.topicId}]`);
    }
    return n;
  }

  #warnOnce(what, msg) {
    if (this.warned.get(what) === msg) return;
    this.warned.set(what, msg);
    this.log(`${what}: ${msg}`);
  }

  // ── Telegram writes: strictly ordered per session ──

  #serial(s, fn) {
    const p = s.chain.then(fn);
    s.chain = p.catch(() => {});
    return p;
  }

  #apply(s, actions) {
    if (!actions.length || s.chatId === null) return Promise.resolve();
    return this.#serial(s, async () => { for (const a of actions) await this.#run(s, a); });
  }

  #save(s) {
    if (s.chatId !== null) this.topics.set(TopicCache.key(s.chatId, s.key), cacheEntry(s, s.title));
  }

  async #run(s, action) {
    if (action === 'create') {
      // Number against sessions that hold (or are creating) a Topic in the same group.
      const taken = new Set([...this.sessions.values()]
        .filter((o) => o !== s && o.chatId === s.chatId && (o.topicId || o.creating)).map((o) => o.title));
      s.title = s.base;
      for (let n = 2; taken.has(s.title); n++) s.title = `${s.base} #${n}`;
      s.creating = true;
      try {
        s.topicId = (await this.telegram.createForumTopic(s.chatId, s.title)).message_thread_id;
        this.#save(s);
      } catch (e) {
        this.log(`createForumTopic ${s.title}: ${e.message} (posting without a Topic)`);
      } finally { s.creating = false; }
      await this.#postNow(s, `session up: ${s.title}${s.project ? ` (${s.project})` : ''}`, {}, false);
      // Telegram auto-pins a Topic's first message; that pin is noise here.
      if (s.topicId) await this.telegram.unpinAllForumTopicMessages(s.chatId, s.topicId).catch((e) => this.#warnOnce('unpinAllForumTopicMessages', e.message));
      return;
    }
    if (action === 'notice-ended') return this.#postNow(s, `session ended: ${s.title}`);
    if (!s.topicId) return;
    const call = action === 'reopen' ? 'reopenForumTopic' : 'closeForumTopic';
    try {
      await this.telegram[call](s.chatId, s.topicId);
    } catch (e) {
      if (!TOPIC_UNCHANGED.test(e.message)) {
        if (TOPIC_GONE.test(e.message) && action === 'reopen') { for (const a of onTopicGone(s)) await this.#run(s, a); return; }
        this.log(`${call} ${s.title}: ${e.message}`);
      }
    }
    this.#save(s);
    this.log(`${action === 'reopen' ? 'reopened' : 'closed'} topic ${s.title} [topic ${s.topicId}]${action === 'close' ? ` (${s.state === 'ended' ? 'ended' : 'idle'})` : ''}`);
  }

  async #postNow(s, text, opts = {}, retry = true) {
    try {
      this.log(`post ${s.title} [topic ${s.topicId ?? '-'}] ${text.replace(/\s+/g, ' ').slice(0, 60)}`);
      return await this.telegram.sendMessage(s.chatId, text, { threadId: s.topicId ?? undefined, ...opts });
    } catch (e) {
      // Telegram-side drift (Topic deleted or closed by hand): repair once, then resend.
      const fix = !retry || !s.topicId ? null : TOPIC_GONE.test(e.message) ? onTopicGone(s) : TOPIC_CLOSED.test(e.message) ? onTopicFoundClosed(s) : null;
      if (fix) {
        for (const a of fix) await this.#run(s, a);
        return this.#postNow(s, text, opts, false);
      }
      this.log(`send ${s.title}: ${e.message}`);
      return [];
    }
  }

  /** Activity: run the lifecycle (create or reopen the Topic), then post, in order. */
  #send(s, text, opts = {}) {
    if (s.chatId === null) return Promise.resolve([]);
    this.#activity(s);
    return this.#serial(s, () => this.#postNow(s, text, opts));
  }

  #activity(s) {
    if (s.chatId !== null) this.#apply(s, onActivity(s, this.now())).catch(() => {});
  }

  // ── session events ──

  /** A prompt typed into the session. One injected from its Topic is skipped once. */
  async prompt(key, text) {
    const s = this.sessions.get(key);
    if (!s) return;
    const now = this.now();
    s.injected = s.injected.filter((x) => now - x.at < ECHO_TTL_MS);
    const i = s.injected.findIndex((x) => x.text === text.trim());
    if (i !== -1) { s.injected.splice(i, 1); this.#activity(s); return; }
    await this.#send(s, `> ${text}`);
  }

  /** One progress message per turn, edited in place and throttled. */
  async progress(key, line) {
    const s = this.sessions.get(key);
    if (!s || s.chatId === null) return;
    this.#activity(s);
    const p = s.progress ??= { lines: [], msgId: null, last: 0, timer: null };
    p.lines = [...p.lines, line].slice(-PROGRESS_LINES);
    const flush = () => this.#serial(s, async () => {
      p.timer = null;
      p.last = this.now();
      const text = `working…\n${p.lines.join('\n')}`;
      if (p.msgId) {
        try { await this.telegram.editMessageText(s.chatId, p.msgId, text); } catch (e) { this.log(`edit: ${e.message}`); }
      } else {
        const [m] = await this.#postNow(s, text);
        p.msgId = m?.message_id ?? null;
      }
    });
    if (this.now() - p.last >= PROGRESS_MIN_INTERVAL_MS) return flush();
    if (!p.timer) { p.timer = setTimeout(flush, PROGRESS_MIN_INTERVAL_MS); p.timer.unref?.(); }
  }

  async final(key, text, status) {
    const s = this.sessions.get(key);
    if (!s) return;
    if (s.progress?.timer) clearTimeout(s.progress.timer);
    s.progress = null;
    const body = text?.trim() ? text : `(turn ${status ?? 'completed'}, no message)`;
    // A failed turn has stopped and waits for the human, like an approval.
    await this.#send(s, status && status !== 'completed' ? `[${status}] ${body}` : body,
      status === 'failed' ? { alert: [...this.allowed] } : {});
  }

  async approval(key, { ref, summary, answerable }) {
    const s = this.sessions.get(key);
    if (!s) return;
    const id = String(this.nextApproval++);
    this.approvals.set(id, { key, agent: s.agent, ref });
    const offer = answerable && this.config.approvalsFromTelegram && this.allowed.size > 0;
    const head = offer ? `approval needed on ${this.machine}` : `approval needed on ${this.machine}, answer locally or via official remote`;
    const replyMarkup = offer ? { inline_keyboard: [[
      { text: 'Accept', callback_data: `ap:${id}:y` }, { text: 'Decline', callback_data: `ap:${id}:n` },
    ]] } : undefined;
    await this.#send(s, `${head}\n${summary}`, { replyMarkup, alert: [...this.allowed] });
  }

  // ── Telegram inbound ──

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
    const host = this.hosts.get(s.agent);
    if (!host) return;   // the lanes Topic is a view, not a session to drive
    const text = m.text.trim();
    const cmd = /^\/(\w+)(?:@\w+)?\s*$/.exec(text)?.[1];
    if (cmd === 'status') return this.#send(s, `${s.title}: ${host.status(s.id)}`);
    if (cmd === 'interrupt') {
      if (!host.interrupt) return this.#send(s, `interrupt is not available for ${s.agent}; use Esc locally`);
      const ok = await host.interrupt(s.id).catch(() => false);
      return this.#send(s, ok ? 'interrupt sent' : 'nothing to interrupt');
    }
    this.#activity(s);
    s.injected = [...s.injected, { text, at: this.now() }].slice(-20);
    try {
      await host.inject(s.id, text, m.from.username ?? String(m.from.id));
    } catch (e) {
      await this.#send(s, `inject failed: ${e.message}`);
    }
  }

  async #onCallback(q) {
    const m = /^ap:(\d+):([yn])$/.exec(q.data ?? '');
    const allowed = this.config.approvalsFromTelegram && this.allowed.has(Number(q.from?.id));
    const a = m && this.approvals.get(m[1]);
    let note = 'not allowed';
    if (allowed && a) {
      const yes = m[2] === 'y';
      const ok = this.hosts.get(a.agent)?.answerApproval(a.ref, yes, this.sessions.get(a.key)?.id);
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
  const claude = new ClaudeAdapter();
  const port = await claude.listen(0);
  writePrivateFile(RUNTIME_FILE, JSON.stringify({ port, token: claude.token, pid: process.pid }, null, 2));
  const codex = new CodexAdapter();
  const bridge = new Bridge({ telegram, adapters: [codex, claude], config, machine, log, topicCacheFile: path.join(BRIDGE_RUNTIME_DIR, 'topics.json') });

  const ac = new AbortController();
  const stop = () => {
    ac.abort();
    try { if (JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).pid === process.pid) fs.rmSync(RUNTIME_FILE); } catch { /* gone */ }
    codex.stop();
    claude.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(`up: machine=${machine} ipc=127.0.0.1:${port} idleCloseMinutes=${config.idleCloseMinutes} deleteClosedAfterHours=${config.deleteClosedAfterHours} observeIntervalSeconds=${config.observeIntervalSeconds} coordinator=${config.coordinator ?? '-'}`);
  codexLoop(codex, log, ac.signal);
  if (config.idleCloseMinutes > 0) {
    setInterval(() => bridge.closeIdle().catch((e) => log(`idle close: ${e.message}`)),
      Math.min(60000, config.idleCloseMinutes * 60000)).unref();
  }
  if (config.observeIntervalSeconds > 0) {
    const observer = new Observer({ machine, config, log, cacheFile: path.join(BRIDGE_RUNTIME_DIR, 'observer.json'),
      sessions: () => bridge.observedSessions(),
      post: (key, text) => bridge.notify(key, text).catch((e) => log(`observe post: ${e.message}`)),
      postLanes: (chatId, project, text) => bridge.postLanes(chatId, project, text).catch((e) => log(`lanes post: ${e.message}`)) });
    const observe = () => observer.poll().catch((e) => log(`observe: ${e.message}`));
    observe();
    setInterval(observe, config.observeIntervalSeconds * 1000).unref();
  }
  if (config.deleteClosedAfterHours > 0) {
    const sweep = () => bridge.sweepClosedTopics().catch((e) => log(`sweep: ${e.message}`));
    sweep();
    setInterval(sweep, 3600000).unref();
  }
  await bridge.pollLoop(ac.signal);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
