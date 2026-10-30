#!/usr/bin/env node
// scripts/bridge/daemon.mjs — the per-machine session bridge (docs/bridge.md).
//
// Owns the machine's single bot token and the only getUpdates loop, and multiplexes every
// live session on the machine. Host specifics live in adapters (codex-adapter.mjs,
// claude-adapter.mjs), which all emit the same events (#wire subscribes to exactly these):
//   up {id, cwd, branch?, seat?, name?, backlog[]}, down {id}, dismiss {id} (not a main session),
//   superseded {id, from}, name {id, name}, status {id},
//   prompt {id, text, turnId?}, message {id, text, turnId?, itemId?}, progress {id, text}, final {id, text, turnId?, status?},
//   notice {id, text, alert?}, approval {id, ref, summary, answerable}, approval-resolved {ref, id?},
//   question {id, ref, answerable, questions[{id, header, question, options|null, isOther, isSecret}]},
//   question-resolved {ref, id?}, warn (text)
// and offer the same interface: inject(id, text, user), status(id), statusSnapshot(id) -> {state},
// answerApproval(ref, allow, id), answerQuestion(ref, {questionId: [answer]}, id), and
// optionally interrupt(id), releaseQuestion(ref, id). The daemon gives each adapter
// sendAttachment(agent, id, request) for files sent through its local requests.
// This file is host-agnostic: one lifecycle (lifecycle.mjs), one ordered write queue per
// session, one bring-up hold, one echo suppression.
//
// Inbound from allowlisted users only: plain text = inject; `/status`, `/interrupt`.
// Approval buttons only when this machine opts in, honoured only for allowlisted ids.
// Question buttons (and text answers) need no opt-in — a question is not an approval — but
// are equally honoured only for allowlisted ids.

import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { acquireDaemonLock } from './ensure.mjs';
import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { TelegramClient, ATTACHMENT_LIMITS } from './telegram.mjs';
import { CodexAdapter } from './codex-adapter.mjs';
import { CodexLocalObserver } from './codex-local.mjs';
import { resolveCodexHome, codexHomeKey } from '../shared/codex-home.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { TopicCache } from './topic-cache.mjs';
import { AccountReader, accountFor } from './quota.mjs';
import { BillingReader } from './billing.mjs';
import { healSyncLinks } from '../setup/check-links.js';
import { DashboardPush } from './dashboard-push.mjs';
import { ResourceReader } from './resources.mjs';
import { UsageScanner, sources as usageSources } from '../usage/scan.mjs';
import { UsagePush } from '../usage/push.mjs';
import { STATUS } from '../dashboard/public/shared/vocab.mjs';
import { newSession, onActivity, onIdleTick, onDown, onTopicGone, onTopicFoundClosed, cacheEntry } from './lifecycle.mjs';
import { readBridgeConfig, gitContext, writePrivateFile, bridgeSourceRevision, bridgeConfigRevision, configSummary, applyConfigChange, BRIDGE_RUNTIME_DIR, RUNTIME_FILE } from './context.mjs';

/** How long a request for the human may be handled at the machine before anyone is mentioned. */
const ALERT_GRACE_MS = 30000;
const PROGRESS_MIN_INTERVAL_MS = 3000;
const PROGRESS_LINES = 12;
const ECHO_TTL_MS = 10 * 60000;   // a Telegram inject that never echoes back is forgotten
const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i;
const TOPIC_CLOSED = /TOPIC_CLOSED/i;
const TOPIC_UNCHANGED = /TOPIC_NOT_MODIFIED/i;

export const sessionKey = (agent, id) => `${agent}:${id}`;
/** Native adapter state -> status code (STATUS in scripts/dashboard/public/shared/vocab.mjs, the one vocabulary). */
export const STATUS_CODES = { running: 'working', idle: 'idle', 'waiting-approval': 'needs_approval', 'waiting-input': 'needs_input', unknown: 'unknown', disconnected: 'ended' };
const statusCode = (state) => STATUS_CODES[state] ?? 'unknown';
/** A session name as its host reports it, or null: one line, bounded. */
export const sessionName = (v) => { const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return t ? t.slice(0, 200) : null; };
const clock = t => new Date(t).toTimeString().slice(0, 5);
const GB = 1024 ** 3;

/**
 * The pinned card's facts beyond the state: the account the session spends (who, each window's
 * use) and this machine's load. Either is left out when unknown; observation-only sessions have
 * no account (quota.mjs accountFor).
 */
/** The card's identity: agent, its Claude seat when not the default, the machine. */
export const cardWho = ({ agent, seat }, machine) => `${agent}${seat ? ` ${seat}` : ''} on ${machine}`;

export function cardDetail(s, { accounts = [], resources = null } = {}) {
  const lines = [];
  const a = accounts.find(x => x.key === accountFor(s, accounts));
  if (a) {
    const used = a.windows.map(w => `${w.k} ${Math.round(w.used)}%`).join(' · ');
    lines.push(`Account: ${a.email ?? a.label ?? a.agent}${used ? ` · used ${used}` : ''}`);
  }
  if (resources) {
    const r = [resources.cpu != null && `CPU ${resources.cpu}%`,
      resources.mem?.total && `RAM ${(resources.mem.used / GB).toFixed(1)}/${(resources.mem.total / GB).toFixed(0)} GB`,
      ...(resources.gpus ?? []).map(g => `GPU ${g.util}% ${(g.memUsed / GB).toFixed(1)}/${(g.memTotal / GB).toFixed(0)} GB`)].filter(Boolean);
    if (r.length) lines.push(`Machine: ${r.join(' · ')}`);
  }
  return lines;
}

/**
 * `[name | ]machine | [project |] branch | agent[ · suffix]`: the session's own name (Claude's
 * /rename or generated title, Codex's thread name) first, so a Topic list reads by task.
 * projectInTitle drops the project in a group dedicated to one repo: 'main' keeps it only on
 * main/master, 'never' always drops it.
 */
export function topicTitle({ name, machine, project, branch, agent, suffix = '', projectInTitle = 'always' }) {
  const clean = value => String(value ?? '').replace(/[|\r\n]/g, ' ').trim();
  const clip = (value, max) => {
    const chars = Array.from(value);
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value;
  };
  const projectName = clean(project).replace(/[-_ ]+(?:studio|lab)(?=$|[-_ ])/gi, '') || 'unknown';
  const showProject = projectInTitle === 'always' || (projectInTitle === 'main' && ['main', 'master'].includes(clean(branch)));
  const label = clean(name);
  const head = `${label ? `${clip(label, 40)} | ` : ''}${clip(clean(machine), 24)} | ${showProject ? `${clip(projectName, 32)} | ` : ''}`;
  const tail = ` | ${clip(clean(agent), 20)}${suffix ? ` · ${suffix}` : ''}`;
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
    topicCacheFile = null, log = () => {}, now = Date.now, alertGraceMs = ALERT_GRACE_MS,
    uploadsDir = path.join(BRIDGE_RUNTIME_DIR, 'uploads'), telegramEnabled = true, cardFacts = () => ({}) }) {
    Object.assign(this, { telegram, config, machine, resolveContext, log, now, alertGraceMs, uploadsDir, cardFacts });
    this.telegramEnabled = telegramEnabled;
    this.hosts = new Map(adapters.map((a) => [a.agent, a]));
    this.sessions = new Map();   // key -> session (lifecycle.mjs record + routing fields)
    this.held = new Map();       // key -> live events that arrived during bring-up
    this.approvals = new Map();  // random id -> native request + delivered message origin
    this.questions = new Map();  // random id -> one question of a native request + its message origin
    this.topics = new TopicCache(topicCacheFile);
    this.deletingTopics = new Set();  // in-flight transport only; never rebind a doomed Topic
    this.retiring = new Map(); // Drain the old session's writes before reusing its Topic/card.
    this.allowed = new Set(config.allowedUserIds);
    this.warned = new Map();     // what -> last logged message (log each distinct failure once)
    for (const a of adapters) this.#wire(a);
  }

  #wire(a) {
    // An adapter that takes local requests (the Claude adapter's IPC) may carry an attachment for any agent's session.
    a.sendAttachment = (agent, id, p) => this.sendAttachment(sessionKey(agent, id), p);
    a.on('up', (e) => this.sessionUp(a.agent, e).catch((err) => this.log(`${a.agent} up: ${err.message}`)));
    a.on('down', (e) => this.sessionDown(sessionKey(a.agent, e.id)));
    a.on('dismiss', (e) => this.dismiss(sessionKey(a.agent, e.id)));
    a.on('status', e => this.updateStatus(sessionKey(a.agent, e.id)).catch(err => this.#warnOnce('status-card', err.message)));
    for (const kind of ['superseded', 'name', 'prompt', 'message', 'progress', 'final', 'notice', 'approval', 'question']) {
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
    a.on('question-resolved', (e) => {
      // Answered locally first (or its hook gave up): the Telegram controls go inactive.
      for (const [key, events] of this.held) {
        if (key.startsWith(`${a.agent}:`)) this.held.set(key, events.filter(({ kind, e: pending }) => kind !== 'question' || pending.ref !== e.ref));
      }
      for (const [id, x] of this.questions) if (x.agent === a.agent && x.group.ref === e.ref
        && (e.id === undefined || x.session.id === e.id)) this.questions.delete(id);
    });
    a.on('warn', (m) => this.log(m));
  }

  #event(key, kind, e) {
    if (kind === 'superseded') return Promise.resolve(this.supersede(key, e.from));
    if (kind === 'name') return this.rename(key, e.name);
    if (kind === 'prompt') return this.prompt(key, e.text);
    if (kind === 'progress') return this.progress(key, e.text);
    if (kind === 'message') return this.notice(key, e.text);
    if (kind === 'final') return this.final(key, e.text, e.status);
    if (kind === 'notice') return this.notice(key, e.text, e.alert);
    if (kind === 'question') return this.question(key, e);
    return this.approval(key, e);
  }

  chatFor(project) {
    if (!this.telegramEnabled) return null;
    return this.config.projects[project]?.chatId ?? this.config.fallbackChatId ?? null;
  }

  /**
   * Register a session, replay its backlog, then release the live events held meanwhile,
   * minus the turns the backlog already carried (a turn that completes during bring-up is
   * reported both ways).
   */
  async sessionUp(agent, { id, cwd, branch, seat = null, name = null, backlog = [] }) {
    const key = sessionKey(agent, id);
    if (this.sessions.has(key) || this.held.has(key)) return this.sessions.get(key);
    this.held.set(key, []);
    try {
      if (this.retiring.has(key)) await this.retiring.get(key);
      const ctx = this.resolveContext(cwd, { branch });
      const chatId = this.chatFor(ctx.project);
      const cacheKey = chatId === null ? null : TopicCache.key(chatId, key);
      const cached = cacheKey === null || this.deletingTopics.has(cacheKey) ? null : this.topics.get(cacheKey);
      // A Claude seat (scripts/shared/seats.mjs) names the login the session runs as.
      const s = { ...newSession({ key, cached, now: this.now() }), agent, id, chatId, name: sessionName(name),
        project: ctx.project, branch: ctx.branch, cwd, seat, chain: Promise.resolve(), progress: null, injected: [] };
      s.titleOf = (suffix = '') => topicTitle({ name: s.name, machine: this.machine, project: ctx.project, branch: ctx.branch,
        agent: seat ? `${agent}:${seat}` : agent, suffix, projectInTitle: this.config.projects[ctx.project]?.projectInTitle });
      const base = s.base = s.title = s.titleOf();
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

  /**
   * This machine's sessions for the dashboard: read-only, from the same registry and
   * adapter snapshots the status cards use. No cwd, no title: the project name stands in.
   * A Topic is listed only once Telegram confirmed it (lazy creation: many sessions have none).
   * A session whose state is unknown is left out: nothing about it can be acted on.
   */
  dashboardSessions() {
    return [...this.sessions.values()].filter((s) => s.state !== 'ended')
      .map((s) => ({ s, snap: this.hosts.get(s.agent)?.statusSnapshot?.(s.id) }))
      .filter(({ snap }) => snap?.state !== 'unknown').map(({ s, snap }) => ({
      id: s.id, agent: s.agent, name: s.name ?? null, project: s.project ?? null, branch: s.branch ?? null, seat: s.seat ?? null,
      unread: s.unread ?? 0, mention: !!s.mention, posted: s.posted ?? 0,
      lastPostAt: s.lastPostAt != null ? new Date(s.lastPostAt).toISOString() : null,
      ...(snap?.observationOnly ? { observationOnly: true } : {}),
      status: statusCode(snap?.state), ...(snap?.background ? { background: snap.background } : {}),
      lastActivityAt: new Date(s.lastActivity).toISOString(),
      topic: s.topicId && s.chatId !== null ? { chatId: s.chatId, topicId: s.topicId, closed: s.state === 'closed',
        ...(s.unread && s.firstUnread ? { firstUnread: s.firstUnread } : {}), ...(s.lastPost ? { lastPost: s.lastPost } : {}) } : null,
    }));
  }

  /**
   * The session's name changed (renamed, or its title generated): the Topic title follows. A
   * Topic not created yet takes the name when it is.
   */
  async rename(key, raw) {
    const s = this.sessions.get(key);
    const name = sessionName(raw);
    if (!s || s.name === name) return;
    s.name = name;
    s.base = s.titleOf();
    // Behind any Topic creation in flight, so the Topic it creates is retitled too.
    await this.#serial(s, async () => {
      if (this.sessions.get(key) !== s) return;
      const title = this.#selectTitle(s, null);
      if (!s.topicId) { s.title = title; return; }
      if (title === s.title) return;
      try { await this.telegram.editForumTopic(s.chatId, s.topicId, title); }
      catch (e) { if (!TOPIC_UNCHANGED.test(e.message)) { this.#warnOnce('editForumTopic', e.message); return; } }
      s.title = title;
      this.#save(s);
      this.log(`renamed topic ${title} [topic ${s.topicId}]`);
    });
  }

  sessionDown(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    this.#serial(s, () => this.#statusNow(s, { offline: true })).catch(err => this.#warnOnce('status-card', err.message));
    for (const [id, a] of this.approvals) if (a.key === key) this.approvals.delete(id);
    for (const [id, q] of this.questions) if (q.key === key) this.questions.delete(id);
    this.log(`down ${key}`);
    if (s.chatId !== null) this.#apply(s, onDown(s, this.now())).catch(() => {});
    const pending = s.chain.catch(() => {});
    this.retiring.set(key, pending);
    pending.finally(() => { if (this.retiring.get(key) === pending) this.retiring.delete(key); });
  }

  /**
   * The host found session `key` continues the conversation of session `fromId` (agent view
   * relaunched it under a new id): `key` takes over that Topic, so the conversation keeps one
   * Topic and Telegram messages reach the live session. A Topic `key` already had is closed.
   */
  supersede(key, fromId) {
    const x = this.sessions.get(key);
    const fromKey = x && sessionKey(x.agent, fromId);
    const y = fromKey && this.sessions.get(fromKey);
    if (!y) return;
    this.sessions.delete(fromKey);
    for (const [id, a] of this.approvals) if (a.key === fromKey) this.approvals.delete(id);
    for (const [id, q] of this.questions) if (q.key === fromKey) this.questions.delete(id);
    if (y.chatId !== null) this.topics.set(TopicCache.key(y.chatId, fromKey), null);
    this.log(`supersede ${fromKey} -> ${key} topic=${y.topicId ?? '-'}`);
    if (!y.topicId) return;
    if (x.topicId && !(x.chatId === y.chatId && x.topicId === y.topicId)) {
      // Cached under a retired key: closed, it ages out through the sweep like any other.
      const own = { ...newSession({ key: `${key}|retired:${x.topicId}`, cached: cacheEntry(x, x.title), now: this.now() }),
        chatId: x.chatId, title: x.title, chain: x.chain };
      this.#apply(own, onDown(own, this.now())).catch(() => {});
    }
    // The old session's in-flight writes land before the new owner's first one.
    x.chain = Promise.all([x.chain, y.chain]).then(() => {}, () => {});
    Object.assign(x, { chatId: y.chatId, topicId: y.topicId, statusMessageId: y.statusMessageId,
      state: y.state, closedAt: y.closedAt, title: y.title, base: y.base });
    this.#save(x);
    this.updateStatus(key).catch(err => this.#warnOnce('status-card', err.message));
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
   * Delete Topics closed more than `deleteClosedAfterHours` ago. A still-registered
   * idle-closed session loses its Topic too and gets a fresh one on its next activity.
   * With `orphans`, an open Topic no registered session holds (its session died while the
   * daemon was down) is first closed so it ages out; skipped at startup, while sessions
   * are still re-registering.
   */
  async sweepClosedTopics({ orphans = false } = {}) {
    let n = 0;
    const holder = (k) => [...this.sessions.values()].find((s) => s.chatId !== null && TopicCache.key(s.chatId, s.key) === k);
    if (orphans) {
      for (const [k, cached] of Object.entries(this.topics.entries)) {
        if (cached.closedAt != null || holder(k) || this.deletingTopics.has(k)) continue;
        const key = k.slice(k.indexOf('|') + 1);
        const s = { ...newSession({ key, cached, now: this.now() }), chatId: TopicCache.chatIdOf(k), title: cached.title ?? key, chain: Promise.resolve() };
        this.log(`orphan topic ${s.title} [topic ${cached.topicId}]: closing`);
        await this.#apply(s, onDown(s, this.now())).catch(() => {});
      }
    }
    for (const [k, e] of this.topics.due(this.now(), this.config.deleteClosedAfterHours)) {
      const held = holder(k);
      if ((held && held.state !== 'closed') || this.deletingTopics.has(k)) continue;
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
      if (held && this.sessions.get(held.key) === held && held.state === 'closed' && held.topicId === e.topicId) {
        Object.assign(held, { topicId: null, statusMessageId: null, state: 'none', closedAt: null });
      }
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
    const { state, observationOnly } = offline ? { state: 'disconnected' } : host.statusSnapshot(s.id);
    // The Topic title already names the session; the card answers only "what is it doing,
    // since when, and how fresh is this".
    if (s.statusState !== state) { s.statusState = state; s.statusSince = this.now(); }
    // A mention says "you are needed, still": once the session runs again (handled at the
    // machine) or is gone, it is not, even before anything new is posted.
    if (s.mention && (state === 'running' || state === 'disconnected')) { this.#clearMention(s); this.#save(s); }
    // Telegram's pin bar shows only the start of the first line: state, then who runs it where.
    const who = { agent: s.agent.split(':')[0], seat: s.seat ?? null };
    const content = `${observationOnly ? 'Observation only (local TUI controls)' : STATUS[statusCode(state)].label} · since ${clock(s.statusSince)} · ${cardWho(who, this.machine)}`;
    if (!force && s.statusText === content) return;
    // Account and load ride along whenever the card is redrawn (a state change or Refresh), never on their own.
    const detail = offline ? [] : cardDetail(who, this.cardFacts());
    const text = [content, ...detail, `Checked ${clock(this.now())}`].join('\n');
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
    const suffixed = [6, 8, 10, 12, 14, 16].map((n) => s.titleOf(hash.slice(0, n)));
    // Keep an already-derived short identity across reconnects, not historical counters.
    if (suffixed.includes(previous) && !taken.has(previous)) return previous;
    const title = [s.base, ...suffixed].find((t) => !taken.has(t));
    if (!title) throw new Error('could not derive a unique live Topic title');
    return title;
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
        this.log(`send attempt ${s.key} project=${s.project} route=${this.config.projects[s.project]?.chatId ? 'project' : 'fallback'} [topic ${s.topicId}] (${text.length} chars)`);
      const { fromHuman, ...send } = opts;
      const sent = await this.telegram.sendMessage(s.chatId, text, { threadId: s.topicId, ...send });
        this.log(`send acknowledged ${s.key} [topic ${s.topicId}] messages=${sent.map(m => m.message_id).join(',') || 'none'}`);
      if (sent.length) this.#posted(s, { fromHuman, mention: send.alert?.length ? sent[0].message_id : null, ids: sent.map((m) => m.message_id) });
      return sent;
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

  /**
   * Activity: run the lifecycle (create or reopen the Topic), then post, in order. Every post is
   * silent; one that needs the human (`alert`) arms a nudge instead of mentioning at once.
   */
  #send(s, text, { alert, ...opts } = {}) {
    this.#activity(s);
    if (s.chatId === null) return Promise.resolve([]);
    if (alert?.length) this.#nudgeLater(s);
    return this.#serial(s, () => this.#postNow(s, text, opts));
  }

  /**
   * A mention means "you are needed, still". So it waits `alertGraceMs`: if the session moved
   * meanwhile (any later post, or it runs again: handled at the machine), nobody is disturbed;
   * otherwise one short reply mentions the allowed users.
   */
  #nudgeLater(s) {
    s.nudgeAt = s.lastActivity;
    if (s.nudge) return;
    s.nudge = setTimeout(() => {
      s.nudge = null;
      if (this.sessions.get(s.key) !== s || s.lastActivity > s.nudgeAt) return;
      if (this.hosts.get(s.agent)?.statusSnapshot?.(s.id)?.state === 'running') return;
      this.#serial(s, () => this.#postNow(s, 'waiting for you', { alert: [...this.allowed] }))
        .catch((e) => this.#warnOnce('nudge', e.message));
    }, this.alertGraceMs);
    s.nudge.unref?.();
  }

  /**
   * A message reached the Topic: unread unless the human wrote it (a prompt typed at the
   * machine). A mention is not counted: it is the @, and stands only until something follows
   * it, then it is deleted, so neither Telegram nor the dashboard keeps an @ for a request that
   * has moved on. Both are saved with the Topic, so a daemon restart can still delete the mention.
   * Counts and message ids only, never text: the ids let the dashboard open the Topic at the
   * first unread post or at the latest one.
   */
  #posted(s, { fromHuman = false, mention = null, ids = [] } = {}) {
    this.#clearMention(s);
    if (mention) { s.mention = mention; this.#save(s); return; }   // the mention itself is not a message to read: it is the @
    const valid = ids.filter(Number.isSafeInteger);
    if (valid.length) s.lastPost = valid.at(-1);
    if (fromHuman) { s.unread = 0; s.firstUnread = null; }
    else {
      if (!s.unread) s.firstUnread = valid[0] ?? null;
      s.unread += 1;
      s.posted = (s.posted ?? 0) + 1;
      s.lastPostAt = this.now();
    }
    this.#save(s);
  }

  /**
   * The human acted in the Topic (wrote, or tapped an answer): what was there is read, and a
   * mention has done its job — the standing one is deleted, a pending one never fires.
   */
  #seen(s, messageId = null) {
    if (Number.isSafeInteger(messageId) && messageId > (s.lastPost ?? 0)) s.lastPost = messageId;   // the human's message is the latest
    s.unread = 0;
    s.firstUnread = null;
    clearTimeout(s.nudge); s.nudge = null;
    this.#clearMention(s);
    this.#save(s);
  }

  /** Delete the standing mention message (the caller saves). */
  #clearMention(s) {
    const id = s.mention;
    if (!id) return;
    s.mention = null;
    this.telegram.deleteMessage(s.chatId, id).catch((e) => this.#warnOnce('delete-mention', e.message));
  }

  #activity(s) {
    if (s.chatId === null) { s.lastActivity = this.now(); return; }
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
    await this.#send(s, `> ${text}`, { fromHuman: true });
  }

  /** One progress message per turn, edited in place and throttled. */
  async progress(key, line) {
    const s = this.sessions.get(key);
    if (!s) return;
    if (s.chatId === null) { this.#activity(s); return; }
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

  /** A side note outside the turn's answer; `alert` when it waits for the human. */
  async notice(key, text, alert) {
    const s = this.sessions.get(key);
    if (s && text?.trim()) await this.#send(s, text, alert ? { alert: [...this.allowed] } : {});
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
      // A Claude Code worktree (<repo>/.claude/worktrees/<name>/) is a full working copy, not
      // the .claude config: what is inside it is judged like any workspace file.
      const workspace = (p) => p.replace(/^\.claude[\\/]worktrees[\\/][^\\/]+(?=[\\/])/, '').replace(/^[\\/]/, '');
      const selected = workspace(path.relative(path.resolve(s.cwd), path.resolve(request.path)));
      const relative = workspace(path.relative(root, file));
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

  /**
   * A question the session asks. Answerable: one message per question, one button per
   * option, and text replies for free-form ones; the native request is answered once every
   * question has an answer. Otherwise (a secret, or a Claude turn typed locally) it is
   * posted as information only.
   */
  async question(key, { ref, questions = [], answerable }) {
    const s = this.sessions.get(key);
    if (!s) return;
    const host = this.hosts.get(s.agent);
    const offer = answerable && this.allowed.size > 0;
    const render = (q) => [q.header && !q.question.startsWith(`[${q.header}]`) ? `[${q.header}] ${q.question}` : q.question,
      ...(q.options ?? []).map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`)].join('\n');
    if (!offer) {
      // Information only: the terminal owns this question, so no mention.
      await this.#send(s, `question on ${this.machine}: answer it in the terminal (a reply here is sent as a new message)\n${questions.map(render).join('\n\n')}`);
      if (answerable) host?.releaseQuestion?.(ref, s.id);
      return;
    }
    const group = { ref, answers: {}, ids: questions.map((q) => q.id), done: false };
    for (const [i, q] of questions.entries()) {
      const id = randomBytes(16).toString('hex');
      const pending = { key, agent: s.agent, session: s, group, question: q, origin: null };
      this.questions.set(id, pending);
      const free = q.isOther || !q.options?.length;
      const head = `question on ${this.machine}${questions.length > 1 ? ` (${i + 1}/${questions.length})` : ''}`;
      const hint = free ? `\n(reply with text to answer${q.options?.length ? ' Other' : ''})` : '';
      const replyMarkup = q.options?.length ? { inline_keyboard: q.options.map((o, n) => [{ text: o.label, callback_data: `qa:${id}:${n}` }]) } : undefined;
      const message = (await this.#send(s, `${head}\n${render(q)}${hint}`, { replyMarkup, alert: [...this.allowed] })).at(-1);
      if (this.questions.get(id) !== pending) return;   // withdrawn while it was being delivered
      if (!message || this.sessions.get(key) !== s) {
        // Not offered on Telegram after all: the whole request goes back to the terminal.
        for (const [other, x] of this.questions) if (x.group === group) this.questions.delete(other);
        host?.releaseQuestion?.(ref, s.id);
        return;
      }
      pending.origin = { chatId: s.chatId, topicId: s.topicId, messageId: message.message_id };
    }
  }

  /** Record one answer; submit the native request once every question has one. */
  async #answer(id, value, from, message) {
    const x = this.questions.get(id);
    this.questions.delete(id);
    this.#seen(x.session);
    x.group.answers[x.question.id] = [value];
    if (message) this.telegram.editMessageText(message.chat.id, message.message_id,
      `${message.text ?? ''}\n-> ${value} by ${from.username ?? from.id}`).catch(() => {});
    if (x.group.done || !x.group.ids.every((q) => x.group.answers[q])) return 'answered';
    x.group.done = true;
    let ok = false;
    try { ok = await this.hosts.get(x.agent)?.answerQuestion(x.group.ref, x.group.answers, x.session.id); } catch { /* reported below */ }
    if (!ok) await this.#send(x.session, 'answer not delivered; answer locally');
    return ok ? 'answered' : 'control inactive';
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
    // Every session talks in its own Topic. General is no session's: a Topic-less session
    // (topicId null, not yet active) would otherwise match it and receive the message.
    if (!m.is_topic_message) return;
    const s = this.#sessionAt(m.chat.id, m.message_thread_id);
    if (!s || s.state === 'ended') return;
    this.#seen(s, m.message_id);
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
    if (!attachment) {
      // While a question waits, a text reply answers it instead of starting a prompt.
      const waiting = [...this.questions].filter(([, x]) => x.session === s && x.origin);
      const [id] = waiting.find(([, x]) => x.question.isOther || !x.question.options?.length) ?? [];
      if (id) return this.#answer(id, text, m.from);
      if (waiting.length) return this.#send(s, 'choose one of the options above');
    }
    this.#activity(s);
    s.injected = [...s.injected, { text, at: this.now() }].slice(-20);
    try {
      const r = await host.inject(s.id, text, m.from.username ?? String(m.from.id), attachment ? { images } : undefined);
      // A host that cannot take it now queues it and says when it will arrive.
      if (r?.queued) await this.#send(s, r.note);
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
    const qa = /^qa:([a-f0-9]{32}):(\d+)$/.exec(q.data ?? '');
    if (qa) {
      const x = this.questions.get(qa[1]);
      const allowed = this.allowed.has(Number(q.from?.id));
      const option = x?.question.options?.[Number(qa[2])];
      const matches = x?.origin && option && q.message?.chat?.id === x.origin.chatId
        && q.message.message_id === x.origin.messageId
        && (q.message.message_thread_id ?? null) === x.origin.topicId
        && this.sessions.get(x.key) === x.session;
      const note = !allowed ? 'not allowed' : matches ? await this.#answer(qa[1], option.label, q.from, q.message) : 'control inactive';
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
      this.#seen(a.session);
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
      try { await codex.start(); }
      finally { await codex.refresh(); } // Local discovery also works without the shared daemon.
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
  if (!config.botToken && !config.dashboard) { log('no Telegram or dashboard transport configured; see docs/bridge.md'); process.exit(1); }
  if (config.botToken && !config.allowedUserIds.length) log('bridge.allowedUserIds is empty: inbound Telegram messages will all be dropped');

  const codexHome = resolveCodexHome();
  const homeKey = codexHomeKey(codexHome);
  const telegram = config.botToken ? new TelegramClient({ token: config.botToken, offsetFile: path.join(BRIDGE_RUNTIME_DIR, 'offset.json') }) : null;
  const claude = new ClaudeAdapter();
  const port = await claude.listen(0);
  writePrivateFile(RUNTIME_FILE, JSON.stringify({ port, token: claude.token, pid: process.pid, codexHome, sourceRevision, configRevision: bridgeConfigRevision(config) }, null, 2));
  const codex = new CodexAdapter({ sources: config.codexSources, localObserver: new CodexLocalObserver({ sources: config.codexSources }) });
  // The pinned card's account and load: the dashboard push's last reading, else a sample of its own.
  const resources = new ResourceReader();
  let lastAccounts = [], lastResources = null;
  const cardFacts = () => ({ accounts: lastAccounts, resources: config.dashboard ? lastResources : resources.read() });
  const bridge = new Bridge({ telegram, adapters: [codex, claude], config, machine, log, telegramEnabled: !!telegram, cardFacts,
    topicCacheFile: telegram ? path.join(BRIDGE_RUNTIME_DIR, 'topics.json') : null });

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
  setInterval(() => bridge.closeIdle().catch((e) => log(`idle close: ${e.message}`)), 60000).unref();
  // One rule for every change: this daemon read its config and code once, so a change to either
  // (a cloud sync, a pull, a dashboard edit) hands over to a fresh daemon — the same check
  // ensure.mjs makes at session start, so a host never waits for a session to apply it.
  const startConfig = bridgeConfigRevision(config);
  let handedOver = false;
  setInterval(() => {
    if (handedOver) return;
    try {
      // A cloud client may have detached the shared settings: re-link first, so this reads what the other hosts read.
      for (const d of healSyncLinks().repaired) log(`config: re-linked ${path.basename(d)} to the sync dir`);
      if (bridgeSourceRevision() === sourceRevision && bridgeConfigRevision() === startConfig) return;
      handedOver = true;
      log('config or source changed: handing over to a fresh daemon');
      spawn(process.execPath, [fileURLToPath(new URL('./ensure.mjs', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { log(`change check: ${e.message}`); }
  }, 60000).unref();
  if (config.dashboardError) log(`dashboard: off (${config.dashboardError})`);
  if (config.dashboard) {
    const accounts = new AccountReader({ machine, log, codexQuota: () => codex.quota, codexAccount: () => codex.account,
      codexFallback: `${machine}/home-${homeKey}`,
      codexSeriesFile: account => path.join(BRIDGE_RUNTIME_DIR, `codex-usage-${homeKey}-${createHash('sha256').update(account?.email ?? 'unknown').digest('hex').slice(0, 16)}.jsonl`) });
    const billing = new BillingReader({ entries: config.billing, log });
    // A dashboard edit is written to the settings file; the change check above then hands over.
    const onConfigChanges = (changes) => {
      const results = changes.map((c) => ({ id: c.id, ...applyConfigChange(c) }));
      for (const r of results) log(`dashboard: config ${changes.find((c) => c.id === r.id).key} ${r.ok ? 'applied' : `refused (${r.error})`}`);
      return results;
    };
    // The usage store (docs/usage.md): the transcripts' turns, each quota window, hourly load.
    const usage = new UsagePush({ url: config.dashboard.url, hostToken: config.dashboard.hostToken, machine, log, accounts: () => lastAccounts,
      scanner: new UsageScanner({ cursorFile: path.join(BRIDGE_RUNTIME_DIR, `usage-cursor-${homeKey}.json`),
        sources: () => usageSources(os.homedir(), { machine, codexHome }) }) });
    const push = new DashboardPush({ ...config.dashboard, machine, log, config: () => configSummary(config),
      sessions: (list) => bridge.dashboardSessions().map(({ observationOnly, ...s }) => ({ ...s, account: observationOnly ? null : accountFor(s, list) })),
      accounts: () => (lastAccounts = accounts.read()), billing: () => billing.read(),
      resources: () => { const r = (lastResources = resources.read()); usage.sample(r); return r; }, onConfigChanges });
    push.start();
    usage.start();
  }
  const sweep = (orphans) => (config.deleteClosedAfterHours > 0 ? bridge.sweepClosedTopics({ orphans }).catch((e) => log(`sweep: ${e.message}`)) : null);
  if (telegram) {
    sweep(false);
    setInterval(() => sweep(true), 3600000).unref();
    await bridge.pollLoop(ac.signal);
  } else {
    log('telemetry-only: Telegram disabled; native session/account collectors remain active');
    await new Promise(resolve => ac.signal.addEventListener('abort', resolve, { once: true }));
  }
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
