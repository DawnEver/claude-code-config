// scripts/shared/dashboard-schema.mjs — the dashboard wire format, the single definition shared by
// the host push (scripts/bridge/dashboard-push.mjs) and the gateway. `parseHostPush` is the trust
// boundary: it whitelists fields, bounds sizes and drops anything malformed, so nothing a
// host sends reaches the Mini App unchecked.

import { isValidMachineName } from './machine.mjs';

export const SCHEMA_VERSION = 1;
export const AGENTS = ['claude', 'codex'];
/** Native session status (scripts/bridge/daemon.mjs STATUS_CODES). Freshness (`stale`) is separate, set by the gateway. */
export const STATUSES = ['working', 'idle', 'needs_approval', 'needs_input', 'ended', 'unknown'];
export const MAX_SESSIONS = 200;
/** A host id is its machine name (scripts/shared/machine.mjs), bounded for the gateway. */
export const isHostId = (id) => isValidMachineName(id) && id.length <= 64;

const text = (v, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A Telegram link only for a private supergroup Topic (`-100<id>`), the only kind the bridge uses. */
export function topicUrl(chatId, topicId) {
  const m = /^-100(\d{1,15})$/.exec(String(chatId));
  return m && Number.isSafeInteger(topicId) && topicId > 0 ? `https://t.me/c/${m[1]}/${topicId}` : null;
}

function parseSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = text(s.id, 128);
  if (!id || !AGENTS.includes(s.agent)) return null;
  const at = Date.parse(s.lastActivityAt);
  const t = s.topic;
  const url = t && topicUrl(t.chatId, t.topicId);
  return {
    id, agent: s.agent, project: text(s.project), branch: text(s.branch, 200), seat: text(s.seat, 64), account: text(s.account, 200),
    status: STATUSES.includes(s.status) ? s.status : 'unknown',
    lastActivityAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    topic: url ? { url, closed: t.closed === true } : null,
  };
}

export const MAX_ACCOUNTS = 20;
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

/** One account's quota: identity, seat checks, windows, resets to act on. */
function parseAccount(a) {
  const key = text(a?.key, 200);
  if (!key || !AGENTS.includes(a.agent)) return null;
  const rc = a.resetCredits;
  const ex = a.extraReset;
  const url = typeof ex?.url === 'string' && /^https:\/\/[^\s"<>]{1,300}$/.test(ex.url) ? ex.url : null;
  return { key, agent: a.agent, label: text(a.label, 64), email: text(a.email, 200), detail: text(a.detail, 200),
    problems: (Array.isArray(a.problems) ? a.problems : []).map((p) => text(p, 200)).filter(Boolean).slice(0, 5),
    at: epoch(a.at), windows: (Array.isArray(a.windows) ? a.windows : []).slice(0, 4).map(parseWindow).filter(Boolean),
    resetCredits: num(rc?.count, 1, 1000) ? { count: rc.count, expiries: (Array.isArray(rc.expiries) ? rc.expiries : []).slice(0, 10).map((x) => (x === null ? null : epoch(x))) } : null,
    extraReset: ex && typeof ex === 'object' ? { at: epoch(ex.at), url } : null };
}

/** A host's config summary (scripts/bridge/context.mjs configSummary): editable values and facts only. */
function parseConfigSummary(c) {
  if (!c || typeof c !== 'object') return null;
  const editable = {};
  for (const [k, v] of Object.entries(c.editable ?? {}).slice(0, 60)) if (configKey(k) && configKey(k).parse(v) !== undefined) editable[k] = v;
  const f = c.facts ?? {};
  return { editable, localOverrides: (Array.isArray(c.localOverrides) ? c.localOverrides : []).filter((k) => k in editable),
    facts: { bridge: f.bridge === true, allowedUsers: num(f.allowedUsers, 0, 1000) ?? 0, approvalsFromTelegram: f.approvalsFromTelegram === true,
      alerts: f.alerts === true, codexSources: (Array.isArray(f.codexSources) ? f.codexSources : []).map((x) => text(x, 32)).filter(Boolean).slice(0, 8),
      dashboardError: text(f.dashboardError, 200) } };
}

const CHANGE_ID = /^[a-f0-9]{16,32}$/;
const parseResult = (r) => (r && CHANGE_ID.test(r.id) ? { id: r.id, ok: r.ok === true, error: r.ok === true ? null : text(r.error, 200) ?? 'failed' } : null);
export const isChangeId = (id) => CHANGE_ID.test(id ?? '');

/** A host's POST body -> {bootAt, seq, sessions, accounts, config, configResults} or null. Unknown session entries are dropped, not fatal. */
export function parseHostPush(body) {
  if (!body || body.schemaVersion !== SCHEMA_VERSION || !Array.isArray(body.sessions)) return null;
  if (!Number.isSafeInteger(body.bootAt) || body.bootAt < 1 || !Number.isSafeInteger(body.seq) || body.seq < 1) return null;
  const seen = new Set();
  const sessions = [];
  for (const raw of body.sessions.slice(0, MAX_SESSIONS)) {
    const s = parseSession(raw);
    if (s && !seen.has(`${s.agent}:${s.id}`)) { seen.add(`${s.agent}:${s.id}`); sessions.push(s); }
  }
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []).slice(0, MAX_ACCOUNTS).map(parseAccount).filter(Boolean);
  return { bootAt: body.bootAt, seq: body.seq, sessions, accounts, config: parseConfigSummary(body.config),
    configResults: (Array.isArray(body.configResults) ? body.configResults : []).slice(0, 20).map(parseResult).filter(Boolean) };
}

// ── Config the dashboard may change ──
// The only keys a remote request can touch: behaviour that grants nothing. Permissions
// (allowedUserIds, approvalsFromTelegram), routing (chat ids) and secrets are never here, so a
// compromised dashboard or Telegram account cannot widen who controls a host or where its
// sessions go. Both the Worker and the host validate against this one table.
const int = (lo, hi) => Object.assign((v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined), { min: lo, max: hi });
// No dots in the name: the key is a dotted path, and a dot would address another object.
const PROJECT = /^bridge\.projects\.([A-Za-z0-9_-]{1,100})\.projectInTitle$/;
export const CONFIG_KEYS = {
  'bridge.idleCloseMinutes': { label: 'Close an idle Topic after (minutes, 0 = never)', parse: int(0, 1440) },
  'bridge.deleteClosedAfterHours': { label: 'Delete a closed Topic after (hours, 0 = never)', parse: int(0, 720) },
  'bridge.dashboard.everySeconds': { label: 'Push to the dashboard every (seconds)', parse: int(5, 3600) },
  'bridge.projects.*.projectInTitle': { label: 'Project name in Topic titles', options: ['always', 'main', 'never'],
    parse: (v) => (['always', 'main', 'never'].includes(v) ? v : undefined) },
};

/** CONFIG_KEYS as plain data for the page (it cannot import this module): label and bounds. */
export const configKeysMeta = () => Object.entries(CONFIG_KEYS).map(([key, s]) => ({ key, label: s.label,
  ...(s.options ? { options: s.options } : { min: s.parse.min, max: s.parse.max }) }));

/** The table entry for a concrete key (a project key matches its `*` pattern), or null. */
export function configKey(key) {
  if (typeof key !== 'string') return null;
  if (CONFIG_KEYS[key] && !key.includes('*')) return CONFIG_KEYS[key];
  return PROJECT.test(key) ? CONFIG_KEYS['bridge.projects.*.projectInTitle'] : null;
}

/** A requested change -> {key, value} when the key is editable and the value valid, else null. */
export function parseConfigChange(c) {
  const spec = configKey(c?.key);
  const value = spec?.parse(c.value);
  return value === undefined || !spec ? null : { key: c.key, value };
}
