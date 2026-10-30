// scripts/shared/dashboard-schema.mjs — the dashboard wire format, the single definition shared by
// the host push (scripts/bridge/dashboard-push.mjs) and the gateway. `parseHostPush` is the trust
// boundary: it whitelists fields, bounds sizes and drops anything malformed, so nothing a
// host sends reaches the Mini App unchecked.

import { isValidMachineName } from './machine.mjs';

export const SCHEMA_VERSION = 1;
import { AGENTS, STATUSES } from '../dashboard/public/shared/vocab.mjs';

export { AGENTS, STATUSES };
/** Native session status (scripts/bridge/daemon.mjs STATUS_CODES). Freshness (`stale`) is separate, set by the gateway. */
export const MAX_SESSIONS = 200;
/** A host id is its machine name (scripts/shared/machine.mjs), bounded for the gateway. */
export const isHostId = (id) => isValidMachineName(id) && id.length <= 64;
/** An API platform's name as the provider catalogue spells it ('deepseek'): a balance account's provider, a session's provider. */
/** A repository key: `<forge host>/<owner>/<name>`, lower-cased (scripts/shared/repo-key.mjs). */
export const isRepoKey = (v) => typeof v === 'string' && v.length <= 200 && /^[a-z0-9.-]+\/[\w.-]+\/[\w.-]+$/.test(v);
export const isProvider = (v) => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);

const text = (v, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * A Telegram link only for a private supergroup Topic (`-100<id>`), the only kind the bridge uses;
 * with `messageId` it opens the Topic at that message.
 */
export function topicUrl(chatId, topicId, messageId = null) {
  const m = /^-100(\d{1,15})$/.exec(String(chatId));
  if (!m || !Number.isSafeInteger(topicId) || topicId <= 0) return null;
  return `https://t.me/c/${m[1]}/${topicId}${Number.isSafeInteger(messageId) && messageId > 0 ? `/${messageId}` : ''}`;
}

const iso = (v) => { const at = Date.parse(v); return Number.isFinite(at) ? new Date(at).toISOString() : null; };

/** `{ [key]: link }` opening the Topic at message `t[field]`, or {} when there is none. */
const atMessage = (t, field, key) => (Number.isSafeInteger(t[field]) && t[field] > 0 ? { [key]: topicUrl(t.chatId, t.topicId, t[field]) } : {});

function parseSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = text(s.id, 128);
  if (!id || !AGENTS.includes(s.agent)) return null;
  const t = s.topic;
  const url = t && topicUrl(t.chatId, t.topicId);
  return {
    id, agent: s.agent, name: text(s.name, 200), project: text(s.project), branch: text(s.branch, 200), seat: text(s.seat, 64), account: text(s.account, 200),
    // The API platform the session spends instead of a subscription; null = a subscription.
    provider: isProvider(s.provider) ? s.provider : null,
    // The forge repository of its working tree (shared/repo-key.mjs): the Code tab's link to it.
    repo: isRepoKey(s.repo) ? s.repo : null,
    status: STATUSES.includes(s.status) ? s.status : 'unknown',
    // Background tasks (shells, agents) an idle session left running.
    ...(num(s.background, 1, 999) ? { background: s.background } : {}),
    unread: num(s.unread, 0, 1e6) ?? 0, mention: s.mention === true,
    // Posts to the Topic ever (a running count: a page keeps what it has seen) and when the last one came.
    posted: num(s.posted, 0, Number.MAX_SAFE_INTEGER) ?? 0, lastPostAt: iso(s.lastPostAt),
    lastActivityAt: iso(s.lastActivityAt),
    // The Topic, and the same Topic opened at its first unread post and at its latest post.
    topic: url ? { url, closed: t.closed === true, ...atMessage(t, 'firstUnread', 'firstUnreadUrl'), ...atMessage(t, 'lastPost', 'latestUrl') } : null,
  };
}

export const MAX_ACCOUNTS = 40;
const num = (v, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const epoch = (v) => num(v, 1e12, 1e14);   // ms, 2001..5138

/** One quota window (scripts/bridge/quota.mjs accountModels): numbers only, bounded. */
function parseWindow(w) {
  const k = typeof w?.k === 'string' && /^\d{1,3}[hd]$/.test(w.k) ? w.k : null;
  const windowMs = num(w?.windowMs, 60000, 400 * 86400000);
  if (!k || windowMs === null) return null;
  const f = w.forecast;
  return { k, used: num(w.used, 0, 100) ?? 0, resetsAt: epoch(w.resetsAt), windowMs,
    cells: (Array.isArray(w.cells) ? w.cells.slice(0, 32) : []).map((c) => (c === null ? null : num(c, -1, 1000) ?? -1)),
    forecast: f && typeof f === 'object' ? { atReset: num(f.atReset, 0, 100000), eta: epoch(f.eta), short: f.short === true } : null };
}

/**
 * One account a session can spend: a subscription (`kind: 'quota'`: identity, seat checks,
 * windows, resets to act on) or an API platform balance (`kind: 'balance'`).
 */
function parseAccount(a) {
  return a?.kind === 'balance' ? parseBalance(a) : parseQuota(a);
}

function parseQuota(a) {
  const key = text(a?.key, 200);
  if (!key || !AGENTS.includes(a.agent)) return null;
  const rc = a.resetCredits;
  const ex = a.extraReset;
  const url = typeof ex?.url === 'string' && /^https:\/\/[^\s"<>]{1,300}$/.test(ex.url) ? ex.url : null;
  return { key, kind: 'quota', agent: a.agent, label: text(a.label, 64), email: text(a.email, 200), detail: text(a.detail, 200),
    problems: (Array.isArray(a.problems) ? a.problems : []).map((p) => text(p, 200)).filter(Boolean).slice(0, 5),
    at: epoch(a.at), windows: (Array.isArray(a.windows) ? a.windows : []).slice(0, 4).map(parseWindow).filter(Boolean),
    resetCredits: num(rc?.count, 1, 1000) ? { count: rc.count, expiries: (Array.isArray(rc.expiries) ? rc.expiries : []).slice(0, 10).map((x) => (x === null ? null : epoch(x))) } : null,
    extraReset: ex && typeof ex === 'object' ? { at: epoch(ex.at), url } : null };
}

/** An API platform balance (scripts/bridge/billing.mjs): its configured entry, amounts per currency, or its error. */
function parseBalance(b) {
  const m = typeof b.key === 'string' ? /^api:([a-z0-9-]{1,32}):([^\s:]{1,64})$/.exec(b.key) : null;
  if (!m || m[1] !== b.provider || !epoch(b.at)) return null;
  return { key: b.key, kind: 'balance', provider: b.provider, label: text(b.label, 64), at: b.at, error: text(b.error, 200),
    balances: (Array.isArray(b.balances) ? b.balances : []).slice(0, 4)
      .filter((x) => /^[A-Z]{3}$/.test(x?.currency) && num(x.amount, -1e9, 1e9) !== null).map((x) => ({ currency: x.currency, amount: x.amount })) };
}

export const MAX_REPOS = 200;
const CI_STATES = ['success', 'failure', 'pending'];
const ci = (v) => (CI_STATES.includes(v) ? v : null);
const https = (v) => (typeof v === 'string' && /^https:\/\/[^\s"<>]{1,300}$/.test(v) ? v : null);

/** One repository as a host's forge reader saw it (scripts/bridge/forges.mjs): branches, open PRs, each head's CI. */
function parseRepo(r) {
  if (!isRepoKey(r?.key) || !['github', 'gitea'].includes(r.forge) || !epoch(r.at)) return null;
  return { key: r.key, forge: r.forge, name: text(r.name, 200), url: https(r.url), private: typeof r.private === 'boolean' ? r.private : null,
    defaultBranch: text(r.defaultBranch, 200), pushedAt: iso(r.pushedAt), at: r.at, error: text(r.error, 200),
    branches: (Array.isArray(r.branches) ? r.branches : []).slice(0, 30).filter((b) => text(b?.name, 200)).map((b) => ({
      name: text(b.name, 200), sha: text(b.sha, 64), at: iso(b.at), author: text(b.author, 100), ci: ci(b.ci) })),
    pulls: (Array.isArray(r.pulls) ? r.pulls : []).slice(0, 30).filter((p) => num(p?.number, 1, 1e9)).map((p) => ({
      number: p.number, title: text(p.title, 300), url: https(p.url), draft: p.draft === true, author: text(p.author, 100),
      head: text(p.head, 200), base: text(p.base, 200), review: ['approved', 'changes', 'required'].includes(p.review) ? p.review : null,
      conflict: p.conflict === true, ci: ci(p.ci), updatedAt: iso(p.updatedAt) })) };
}

/** A host's load (scripts/bridge/resources.mjs): CPU %, memory and each GPU, numbers and a GPU model name only. */
function parseResources(r) {
  if (!r || typeof r !== 'object') return null;
  const TB = 1e15;
  const mem = num(r.mem?.total, 1, TB) ? { used: num(r.mem.used, 0, r.mem.total) ?? 0, total: r.mem.total,
    type: typeof r.mem.type === 'string' && /^(LP)?DDR\d?X?$/.test(r.mem.type) ? r.mem.type : null } : null;
  return { cpu: num(r.cpu, 0, 100), cores: num(r.cores, 1, 4096), cpuModel: text(r.cpuModel, 80), mem,
    gpus: (Array.isArray(r.gpus) ? r.gpus : []).slice(0, 8).filter((g) => num(g?.memTotal, 1, TB)).map((g) => ({ name: text(g.name, 64),
      util: num(g.util, 0, 100), memUsed: num(g.memUsed, 0, g.memTotal) ?? 0, memTotal: g.memTotal })) };
}

/** A host's config summary (scripts/bridge/context.mjs configSummary): editable values and facts only. */
function parseConfigSummary(c) {
  if (!c || typeof c !== 'object') return null;
  const editable = {};
  for (const [k, v] of Object.entries(c.editable ?? {}).slice(0, 60)) if (configKey(k) && configKey(k).parse(v) !== undefined) editable[k] = v;
  const f = c.facts ?? {};
  return { editable, localOverrides: (Array.isArray(c.localOverrides) ? c.localOverrides : []).filter((k) => k in editable),
    facts: { bridge: f.bridge === true, allowedUsers: num(f.allowedUsers, 0, 1000) ?? 0, approvalsFromTelegram: f.approvalsFromTelegram === true,
      codexSources: (Array.isArray(f.codexSources) ? f.codexSources : []).map((x) => text(x, 32)).filter(Boolean).slice(0, 8),
      dashboardError: text(f.dashboardError, 200) } };
}

const CHANGE_ID = /^[a-f0-9]{16,32}$/;
const parseResult = (r) => (r && CHANGE_ID.test(r.id) ? { id: r.id, ok: r.ok === true, error: r.ok === true ? null : text(r.error, 200) ?? 'failed' } : null);

/** A host's POST body -> {bootAt, seq, sessions, accounts, resources, config, configResults} or null. Unknown session entries are dropped, not fatal. */
export function parseHostPush(body) {
  if (!body || body.schemaVersion !== SCHEMA_VERSION || !Array.isArray(body.sessions)) return null;
  if (!Number.isSafeInteger(body.bootAt) || body.bootAt < 1 || !Number.isSafeInteger(body.seq) || body.seq < 1) return null;
  const seen = new Set();
  const sessions = [];
  for (const raw of body.sessions.slice(0, MAX_SESSIONS)) {
    const s = parseSession(raw);
    // A session in an unknown state can be neither read nor acted on: hidden here, whatever bridge version pushed it.
    if (s?.status === 'unknown') continue;
    if (s && !seen.has(`${s.agent}:${s.id}`)) { seen.add(`${s.agent}:${s.id}`); sessions.push(s); }
  }
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []).slice(0, MAX_ACCOUNTS).map(parseAccount).filter(Boolean);
  // Repos ride a push only when the host has a new reading: absent means "unchanged", not "none".
  const repos = Array.isArray(body.repos) ? body.repos.slice(0, MAX_REPOS).map(parseRepo).filter(Boolean) : undefined;
  return { bootAt: body.bootAt, seq: body.seq, sessions, accounts, ...(repos ? { repos } : {}), resources: parseResources(body.resources), config: parseConfigSummary(body.config),
    configResults: (Array.isArray(body.configResults) ? body.configResults : []).slice(0, 20).map(parseResult).filter(Boolean) };
}

// The config keys the dashboard may change: defined in the page-loadable shared layer.
export { CONFIG_KEYS, configKeysMeta, configKey, parseConfigChange } from '../dashboard/public/shared/config-keys.mjs';
import { configKey } from '../dashboard/public/shared/config-keys.mjs';
