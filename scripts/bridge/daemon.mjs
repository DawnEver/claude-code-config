#!/usr/bin/env node
// scripts/bridge/daemon.mjs — the per-machine session bridge (docs/bridge.md).
//
// Owns the machine's single bot token and the only getUpdates loop, and multiplexes every
// live session on the machine. Host specifics live in adapters (codex-adapter.mjs,
// claude-adapter.mjs), which all emit the same events:
//   up {id, cwd, branch?, backlog[]}, prompt {id, text, turnId?},
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
import { randomBytes, createHash } from 'crypto';
import { acquireDaemonLock } from './ensure.mjs';
import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { TelegramClient, ATTACHMENT_LIMITS } from './telegram.mjs';
import { CodexAdapter } from './codex-adapter.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { TopicCache } from './topic-cache.mjs';
import { FleetCard } from './fleet.mjs';
import { newSession, onActivity, onIdleTick, onDown, onTopicGone, onTopicFoundClosed, cacheEntry } from './lifecycle.mjs';
import { readBridgeConfig, gitContext, writePrivateFile, bridgeSourceRevision, BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './context.mjs';

const PROGRESS_MIN_INTERVAL_MS = 3000;
const PROGRESS_LINES = 12;
const ECHO_TTL_MS = 10 * 60000;   // a Telegram inject that never echoes back is forgotten
const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i;
const TOPIC_CLOSED = /TOPIC_CLOSED/i;
const TOPIC_UNCHANGED = /TOPIC_NOT_MODIFIED/i;

export const sessionKey = (agent, id) => `${agent}:${id}`;
const STATUS_LABELS = { running: 'Working', idle: 'Idle', 'waiting-approval': 'Needs approval', unknown: 'Unknown', disconnected: 'Ended' };
const clock = t => new Date(t).toTimeString().slice(0, 5);

export function topicTitle(machine, project, branch, agent, suffix = '') {
  const clean = value => String(value ?? '').replace(/[|\r\n]/g, ' ').trim();
  const clip = (value, max) => {
    const chars = Array.from(value);
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value;
  };
  const name = clean(project).replace(/[-_ ]+(?:studio|lab)(?=$|[-_ ])/gi, '') || 'unknown';
  const head = `${clip(name, 32)} | `;
  const tail = ` | ${clip(clean(machine), 24)} | ${clip(clean(agent), 12)}${suffix ? ` · ${suffix}` : ''}`;
  const available = Math.max(1, 128 - Array.from(head + tail).length);
  const source = Array.from(clean(branch) || 'detached');
  const shortened = source.length > available ? source.slice(0, available - 1).join('') + '…' : source.join('');
  return head + shortened + tail;
}

export class Bridge {
  /**
   * @param {{ telegram, adapters?: EventEmitter[], config, machine: string,
   *           resolveContext?: (cwd, hints) => {project, branch},
   *           topicCacheFile?: string|null, log?: (msg) => void, now?: () => number }} deps
   */
  constructor({ telegram, adapters = [], config, machine, resolveContext = gitContext,
    topicCacheFile = null, log = () => {}, now = Date.now,
    uploadsDir = path.join(BRIDGE_RUNTIME_DIR, 'uploads') }) {
    Object.assign(this, { telegram, config, machine, resolveContext, log, now, uploadsDir });
    this.hosts = new Map(adapters.map((a) => [a.agent, a]));
    this.sessions = new Map();   // key -> session (lifecycle.mjs record + routing fields)
    this.held = new Map();       // key -> live events that arrived during bring-up
    this.approvals = new Map();  // random id -> native request + delivered message origin
    this.topics = new TopicCache(topicCacheFile);
    this.deletingTopics = new Set();  // in-flight transport only; never rebind a doomed Topic
    this.retiring = new Map(); // Drain the old session's writes before reusing its Topic/card.
    this.allowed = new Set(config.allowedUserIds);
    this.warned = new Map();     // what -> last logged message (log each distinct failure once)
    for (const a of adapters) this.#wire(a);
  }

  #wire(a) {
    if (a.agent === 'claude') a.sendAttachment = (id, p) => this.sendAttachment(sessionKey(a.agent, id), p);
    if (a.agent === 'claude') a.sendCodexAttachment = (id, p) => this.sendAttachment(sessionKey('codex', id), p);
    a.on('up', (e) => this.sessionUp(a.agent, e).catch((err) => this.log(`${a.agent} up: ${err.message}`)));
    a.on('down', (e) => this.sessionDown(sessionKey(a.agent, e.id)));
    a.on('dismiss', (e) => this.dismiss(sessionKey(a.agent, e.id)));
    a.on('status', e => this.updateStatus(sessionKey(a.agent, e.id)).catch(err => this.#warnOnce('status-card', err.message)));
    for (const kind of ['prompt', 'progress', 'final', 'approval']) {
      a.on(kind, (e) => {
        const key = sessionKey(a.agent, e.id);
        const q = this.held.get(key);
        if (q) q.push({ kind, e }); else this.#event(key, kind, e).catch((err) => this.log(`${kind}: ${err.message}`));
      });
    }
    a.on('approval-resolved', (e) => {
      for (const [key, events] of this.held) {
        if (!key.startsWith(`${a.agent}:`) || (e.id !== undefined && key !== sessionKey(a.agent, e.id))) continue;
        this.held.set(key, events.filter(({ kind, e: pending }) => kind !== 'approval' || pending.ref !== e.ref));
      }
      for (const [id, x] of this.approvals) if (x.agent === a.agent && x.ref === e.ref
        && (e.id === undefined || x.session.id === e.id)) this.approvals.delete(id);
      for (const s of this.sessions.values()) if (s.agent === a.agent && (e.id === undefined || s.id === e.id))
        this.updateStatus(s.key).catch(err => this.#warnOnce('status-card', err.message));
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
  async sessionUp(agent, { id, cwd, branch, backlog = [] }) {
    const key = sessionKey(agent, id);
    if (this.sessions.has(key) || this.held.has(key)) return this.sessions.get(key);
    this.held.set(key, []);
    try {
      if (this.retiring.has(key)) await this.retiring.get(key);
      const ctx = this.resolveContext(cwd, { branch });
      const chatId = this.chatFor(ctx.project);
      const cacheKey = chatId === null ? null : TopicCache.key(chatId, key);
      const cached = cacheKey === null || this.deletingTopics.has(cacheKey) ? null : this.topics.get(cacheKey);
      const base = topicTitle(this.machine, ctx.project, ctx.branch, agent);
      const s = { ...newSession({ key, cached, now: this.now() }), agent, id, chatId, base,
        title: base, project: ctx.project, branch: ctx.branch, cwd, chain: Promise.resolve(), progress: null, injected: [] };
      this.sessions.set(key, s);
      s.title = this.#selectTitle(s, cached?.title);
      if (cached && cached.title !== s.title) {
        await this.#serial(s, async () => {
          try {
            await this.telegram.editForumTopic(s.chatId, s.topicId, s.title);
            if (this.sessions.get(key) !== s) return;
            this.#save(s);
          } catch (e) {
            if (TOPIC_UNCHANGED.test(e.message)) this.#save(s);
            else { s.title = cached.title ?? base; this.#warnOnce('editForumTopic', e.message); }
          }
        });
        if (this.sessions.get(key) !== s) return;
      }
      this.log(`up ${key} project=${ctx.project} branch=${ctx.branch} topic=${s.topicId ?? '-'}`);
      // No Topic on up: it is created lazily by the first real activity.
      if (chatId === null) this.log(`no chat for project ${ctx.project}; ${key} not mirrored`);
      await this.updateStatus(key).catch(e => this.#warnOnce('status-card', e.message));
      for (const b of backlog) await this.#event(key, b.kind, b);
    } finally {
      const seen = new Set(backlog.filter((b) => b.turnId).map((b) => `${b.kind}:${b.turnId}`));
      const q = this.held.get(key) ?? [];
      this.held.delete(key);
      for (const { kind, e } of q) if (!(e.turnId && seen.has(`${kind}:${e.turnId}`))) await this.#event(key, kind, e).catch(() => {});
    }
    return this.sessions.get(key);
  }

  /** What the fleet card lists: sessions that have shown activity (they own a Topic). */
  fleetSessions() {
    return [...this.sessions.values()].filter((s) => s.topicId && s.state !== 'ended').map((s) => ({
      title: s.title, status: STATUS_LABELS[this.hosts.get(s.agent)?.statusSnapshot?.(s.id).state] ?? 'Unknown' }));
  }

  sessionDown(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    this.#serial(s, () => this.#statusNow(s, { offline: true })).catch(err => this.#warnOnce('status-card', err.message));
    for (const [id, a] of this.approvals) if (a.key === key) this.approvals.delete(id);
    this.log(`down ${key}`);
    if (s.chatId !== null) this.#apply(s, onDown(s, this.now())).catch(() => {});
    const pending = s.chain.catch(() => {});
    this.retiring.set(key, pending);
    pending.finally(() => { if (this.retiring.get(key) === pending) this.retiring.delete(key); });
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
      this.#apply(s, onDown(s, this.now())).catch(() => {});
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
      if (holder(k) || this.deletingTopics.has(k)) continue;
      this.deletingTopics.add(k);
      try {
        await this.telegram.deleteForumTopic(TopicCache.chatIdOf(k), e.topicId);
      } catch (err) {
        if (!TOPIC_GONE.test(err.message)) {
          // A re-attach may have replaced this cache slot while deletion was in flight.
          // Preserve only the retired transport identity, never overwrite the live binding.
          if (this.topics.get(k) !== e) this.topics.set(`${k}|retired:${e.topicId}`, e);
          this.#warnOnce('deleteForumTopic', `${err.message} (needs the "Delete messages" right; kept for the next sweep)`);
          continue;
        }
      } finally { this.deletingTopics.delete(k); }
      this.warned.delete('deleteForumTopic');
      if (this.topics.get(k) === e) this.topics.set(k, null);
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

  updateStatus(key, force = false) {
    const s = this.sessions.get(key);
    return s ? this.#serial(s, () => this.#statusNow(s, { force })) : Promise.resolve();
  }

  async #statusNow(s, { offline = false, force = false, first = false } = {}) {
    const host = this.hosts.get(s.agent);
    if (!s.topicId || s.chatId == null || !host?.statusSnapshot ||
        (offline ? this.sessions.has(s.key) : this.sessions.get(s.key) !== s)) return;
    const topicId = s.topicId;
    const { state } = offline ? { state: 'disconnected' } : host.statusSnapshot(s.id);
    // The Topic title already names the session; the card answers only "what is it doing,
    // since when, and how fresh is this".
    if (s.statusState !== state) { s.statusState = state; s.statusSince = this.now(); }
    const content = `${STATUS_LABELS[state] ?? 'Unknown'} · since ${clock(s.statusSince)}`;
    if (!force && s.statusText === content) return;
    const text = `${content}\nChecked ${clock(this.now())}`;
    s.statusRef ??= randomBytes(12).toString('hex');
    const replyMarkup = { inline_keyboard: offline ? [] : [[{ text: 'Refresh status', callback_data: `status:${s.statusRef}` }]] };
    if (s.statusMessageId) {
      try { await this.telegram.editMessageText(s.chatId, s.statusMessageId, text, { replyMarkup }); }
      catch (e) {
        if (/MESSAGE_NOT_MODIFIED|message is not modified/i.test(e.message)) { s.statusText = content; return; }
        if (!/message to edit not found|MESSAGE_ID_INVALID/i.test(e.message)) throw e;
        s.statusMessageId = null;
      }
    }
    if (!s.statusMessageId) {
      if (offline) return;
      const [message] = await this.telegram.sendMessage(s.chatId, text, { threadId: s.topicId, replyMarkup });
      if (this.sessions.get(s.key) !== s || s.topicId !== topicId) return;
      s.statusMessageId = message?.message_id;
      if (s.statusMessageId) {
        this.#save(s);
        // A Topic's first message is pinned by Telegram itself; only a re-sent card needs it.
        if (!first) await this.telegram.pinChatMessage?.(s.chatId, s.statusMessageId).catch(e => this.#warnOnce('pin-status', e.message));
      }
    }
    s.statusText = content;
  }

  #selectTitle(s, previous) {
    const taken = new Set([...this.sessions.values()]
      .filter(o => o !== s && o.chatId === s.chatId && (o.topicId || o.creating)).map(o => o.title));
    const hash = createHash('sha256').update(s.key).digest('hex');
    // Keep an already-derived short identity across reconnects, not historical counters.
    for (let length = 6; length <= 16; length += 2) {
      const candidate = topicTitle(this.machine, s.project, s.branch, s.agent, hash.slice(0, length));
      if (previous === candidate && !taken.has(candidate)) return candidate;
    }
    if (!taken.has(s.base)) return s.base;
    for (let length = 6; length <= 16; length += 2) {
      const candidate = topicTitle(this.machine, s.project, s.branch, s.agent, hash.slice(0, length));
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error('could not derive a unique live Topic title');
  }

  async #run(s, action) {
    if (action === 'create') {
      s.title = this.#selectTitle(s, s.title);
      s.creating = true;
      s.statusMessageId = null; s.statusText = null;
      try {
        s.topicId = (await this.telegram.createForumTopic(s.chatId, s.title)).message_thread_id;
        this.#save(s);
      } catch (e) {
        if (e.code >= 400 && e.code < 500) s.state = 'none'; // confirmed rejection: later activity may retry
        this.log(`createForumTopic ${s.title}: ${e.message} (not delivered; check Telegram before restarting)`);
      } finally { s.creating = false; }
      // The status card is the Topic's first message, so Telegram pins it.
      await this.#statusNow(s, { first: true }).catch((e) => this.#warnOnce('status-card', e.message));
      return;
    }
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
    if (!s.topicId) {
      this.log(`send ${s.title}: not delivered (no confirmed Topic; use native session history)`);
      return [];
    }
    try {
      this.log(`post ${s.title} [topic ${s.topicId}] (${text.length} chars)`);
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
    if (this.hosts.get(s.agent)?.statusSnapshot) { this.#activity(s); return this.updateStatus(key); }
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
      status === 'failed' ? { alert: [...this.allowed] } : { rich: true });
  }

  async sendAttachment(key, request) {
    const s = this.sessions.get(key);
    if (!s || s.state === 'ended' || s.chatId == null) throw new Error('live attachment session required');
    if (typeof request.path !== 'string' || !path.isAbsolute(request.path)) throw new Error('absolute file path required');
    this.#activity(s);
    return this.#serial(s, async () => {
      if (this.sessions.get(key) !== s || !s.topicId || s.state === 'ended') throw new Error('no live confirmed attachment Topic');
      const root = fs.realpathSync(s.cwd);
      const file = fs.realpathSync(request.path);
      // Compare like with like: the path as given against the cwd as given, the realpath
      // against the real root — a symlinked cwd (macOS /var -> /private/var) otherwise reads as outside.
      const selected = path.relative(path.resolve(s.cwd), path.resolve(request.path));
      const relative = path.relative(root, file);
      const blocked = p => !p || p.startsWith(`..${path.sep}`) || p === '..' || path.isAbsolute(p) ||
        p.split(path.sep).some(part => /^\.(?:git|claude|codex|ssh|aws|npmrc|netrc|env(?:\..*)?)$/i.test(part)) ||
        /(?:^|[\\/])(?:credentials|secrets?|private[-_]key)(?:[.\\/]|$)|\.(?:pem|key|p12)$/i.test(p);
      if (blocked(selected) || blocked(relative)) {
        throw new Error('attachment must be a non-sensitive workspace file');
      }
      return this.telegram.sendAttachment(s.chatId, file, { kind: request.kind ?? 'document',
        caption: request.caption, threadId: s.topicId, workspaceRoot: root });
    });
  }

  async approval(key, { ref, summary, answerable }) {
    const s = this.sessions.get(key);
    if (!s) return;
    const offer = answerable && this.config.approvalsFromTelegram && this.allowed.size > 0;
    const id = randomBytes(16).toString('hex');
    const pending = { key, agent: s.agent, ref, session: s, origin: null };
    if (offer) this.approvals.set(id, pending);
    const head = offer ? `approval needed on ${this.machine}` : `approval needed on ${this.machine}, answer locally or via official remote`;
    const replyMarkup = offer ? { inline_keyboard: [[
      { text: 'Accept', callback_data: `ap:${id}:y` }, { text: 'Decline', callback_data: `ap:${id}:n` },
    ]] } : undefined;
    const messages = await this.#send(s, `${head}\n${summary}`, { replyMarkup, alert: [...this.allowed] });
    const message = messages.at(-1);   // Telegram puts the buttons on the final chunk
    if (this.approvals.get(id) === pending) {
      if (message && this.sessions.get(key) === s) pending.origin = { chatId: s.chatId, topicId: s.topicId, messageId: message.message_id };
      else this.approvals.delete(id);
    }
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
    if (!m || !this.allowed.has(Number(m.from?.id))) return;
    const s = this.#sessionAt(m.chat.id, m.is_topic_message ? m.message_thread_id : null);
    if (!s || s.state === 'ended') return;
    const host = this.hosts.get(s.agent);
    let text = (m.text ?? m.caption ?? '').trim();
    const attachment = m.document ?? m.photo?.at(-1);
    if (!text && !attachment) return;
    const images = [];
    if (attachment) {
      const origin = { chatId: s.chatId, topicId: s.topicId };
      try {
        const limit = ATTACHMENT_LIMITS.download;
        if (attachment.file_size > limit) throw new Error('attachment exceeds 20 MiB download limit');
        const data = await this.telegram.downloadAttachment(attachment.file_id, { maxBytes: limit });
        // Never inject into a replacement session after an asynchronous download.
        if (this.sessions.get(s.key) !== s || s.state === 'ended' ||
            s.chatId !== origin.chatId || s.topicId !== origin.topicId) return;
        if (!Buffer.isBuffer(data) || data.length > limit) throw new Error('invalid attachment download');
        fs.mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 });
        // Retention is transport storage, not a second conversation history.
        const files = fs.readdirSync(this.uploadsDir).filter((name) => /^[a-f0-9]{32}\.[a-z0-9]{1,10}$/.test(name))
          .map((name) => { const file = path.join(this.uploadsDir, name); return { file, stat: fs.lstatSync(file) }; })
          .filter(({ stat }) => stat.isFile()).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        let bytes = files.reduce((sum, { stat }) => sum + stat.size, 0);
        for (const { file, stat } of files) {
          if (Date.now() - stat.mtimeMs < 7 * 86400000 && bytes + data.length <= 100 * 1024 * 1024) break;
          fs.unlinkSync(file); bytes -= stat.size;
        }
        const rawExtension = m.document ? path.extname(attachment.file_name ?? '').toLowerCase() : '.jpg';
        const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : '.bin';
        const file = path.join(this.uploadsDir, `${randomBytes(16).toString('hex')}${extension}`);
        writePrivateFile(file, data);
        if (!m.document || /\.(png|jpe?g|webp|gif)$/i.test(extension)) images.push(file);
        text = `${text ? `${text}\n\n` : ''}Telegram attachment (untrusted content): @${file}`;
      } catch {
        // Download errors can contain URLs, credentials or paths: report only a safe outcome.
        return this.#send(s, 'attachment failed: could not download or store file (20 MiB maximum)');
      }
    }
    const cmd = /^\/(\w+)(?:@\w+)?\s*$/.exec(text)?.[1];
    if (cmd === 'status') return host.statusSnapshot ? this.updateStatus(s.key, true)
      : this.#send(s, `${s.title}: ${host.status(s.id)}`);
    if (cmd === 'interrupt') {
      if (!host.interrupt) return this.#send(s, `interrupt is not available for ${s.agent}; use Esc locally`);
      const ok = await host.interrupt(s.id).catch(() => false);
      return this.#send(s, ok ? 'interrupt sent' : 'nothing to interrupt');
    }
    this.#activity(s);
    s.injected = [...s.injected, { text, at: this.now() }].slice(-20);
    try {
      await host.inject(s.id, text, m.from.username ?? String(m.from.id), attachment ? { images } : undefined);
    } catch (e) {
      await this.#send(s, `inject failed: ${e.message}`);
    }
  }

  async #onCallback(q) {
    if (/^status:[a-f0-9]{24}$/.test(q.data ?? '')) {
      const s = [...this.sessions.values()].find(s => `status:${s.statusRef}` === q.data);
      const allowed = this.allowed.has(Number(q.from?.id));
      const matches = s && q.message?.chat?.id === s.chatId && q.message?.message_id === s.statusMessageId
        && q.message?.message_thread_id === s.topicId;
      let note = allowed ? 'control inactive' : 'not allowed';
      if (allowed && matches) {
        try { await this.updateStatus(s.key, true); note = 'status refreshed'; }
        catch { note = 'status unavailable; check locally'; }
      }
      await this.telegram.answerCallbackQuery(q.id, note).catch(() => {});
      return;
    }
    const m = /^ap:([a-f0-9]{32}):([yn])$/.exec(q.data ?? '');
    const allowed = this.config.approvalsFromTelegram && this.allowed.has(Number(q.from?.id));
    const a = m && this.approvals.get(m[1]);
    let note = 'not allowed';
    const origin = a?.origin;
    const matches = origin && q.message?.chat?.id === origin.chatId
      && q.message.message_id === origin.messageId
      && (q.message.message_thread_id ?? null) === origin.topicId
      && this.sessions.get(a.key) === a.session;
    if (allowed && a && matches) {
      const yes = m[2] === 'y';
      this.approvals.delete(m[1]);
      let ok;
      try { ok = await this.hosts.get(a.agent)?.answerApproval(a.ref, yes, a.session.id); }
      catch { note = 'submission uncertain; check locally'; }
      if (note === 'not allowed') note = ok ? 'submitted' : 'control inactive';
      if (ok && q.message) this.telegram.editMessageText(q.message.chat.id, q.message.message_id, `${q.message.text ?? ''}\n-> ${note} by ${q.from.username ?? q.from.id}`).catch(() => {});
    } else if (allowed) note = 'control inactive';
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

export async function main() {
  const sourceRevision = bridgeSourceRevision();
  const logIdx = process.argv.indexOf('--log');
  const logFile = logIdx > 0 ? process.argv[logIdx + 1] : null;
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = (m) => {
    const line = `[bridge ${new Date().toISOString()}] ${m}`;
    console.error(line);
    if (logFile) try { fs.appendFileSync(logFile, line + '\n'); } catch { /* best effort */ }
  };
  const releaseLock = acquireDaemonLock();
  if (!releaseLock) { log('already running; one getUpdates consumer per bot token'); process.exit(0); }
  process.on('exit', releaseLock);
  const config = readBridgeConfig();
  const machine = readMachineName();
  if (!machine) { log('no machine name (~/.claude/machine.json); run setup.js --machine <NAME>'); process.exit(1); }
  if (!config.botToken) { log('no bridge.botToken in ~/.claude/claude_env_settings.local.json; see docs/bridge.md'); process.exit(1); }
  if (!config.allowedUserIds.length) log('bridge.allowedUserIds is empty: inbound Telegram messages will all be dropped');

  const telegram = new TelegramClient({ token: config.botToken, offsetFile: path.join(BRIDGE_RUNTIME_DIR, 'offset.json') });
  const claude = new ClaudeAdapter();
  const port = await claude.listen(0);
  writePrivateFile(RUNTIME_FILE, JSON.stringify({ port, token: claude.token, pid: process.pid, sourceRevision }, null, 2));
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
  log(`up: machine=${machine} ipc=127.0.0.1:${port} idleCloseMinutes=${config.idleCloseMinutes} deleteClosedAfterHours=${config.deleteClosedAfterHours}`);
  codexLoop(codex, log, ac.signal);
  if (config.idleCloseMinutes > 0) {
    setInterval(() => bridge.closeIdle().catch((e) => log(`idle close: ${e.message}`)),
      Math.min(60000, config.idleCloseMinutes * 60000)).unref();
  }
  if (config.fleet) {
    const card = new FleetCard({ telegram, ...config.fleet, machine, log, alertIds: config.allowedUserIds,
      stateFile: path.join(BRIDGE_RUNTIME_DIR, 'fleet-card.json'),
      sessions: () => bridge.fleetSessions(), codexQuota: () => codex.quota });
    const tick = () => card.tick().catch((e) => log(`fleet card: ${e.message}`));
    tick();
    setInterval(tick, 60000).unref();
  }
  if (config.deleteClosedAfterHours > 0) {
    const sweep = () => bridge.sweepClosedTopics().catch((e) => log(`sweep: ${e.message}`));
    sweep();
    setInterval(sweep, 3600000).unref();
  }
  await bridge.pollLoop(ac.signal);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
