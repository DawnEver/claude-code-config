// scripts/shared/usage-schema.mjs — the usage wire format (host -> store, docs/usage.md) and the
// read-only SQL gate, shared by the host push (scripts/usage/push.mjs) and the Worker
// (scripts/dashboard/usage-store.mjs). `parseUsageBatch` is the trust boundary: it whitelists
// fields, bounds every value and drops a malformed row, so nothing unchecked reaches the store.
// The store's columns are described once, in scripts/dashboard/migrations/*.sql.

import { AGENTS } from '../dashboard/public/shared/vocab.mjs';

export const USAGE_SCHEMA_VERSION = 1;
/** Rows of one kind per request: about 120 KB of turns, under the gateway's body limit. */
export const MAX_USAGE_ROWS = 250;

const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v, lo = 0, hi = 1e13) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null);
const real = (v, lo = 0, hi = 1e16) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const epoch = (v) => int(v, 1e12, 1e14);
const agent = (v) => (AGENTS.includes(v) ? v : null);
const id = (v) => (typeof v === 'string' && /^[\w:.-]{1,160}$/.test(v) ? v : null);

const TOKENS = ['input', 'cache_read', 'cache_write', 'output', 'reasoning'];

function parseTurn(r) {
  const a = agent(r?.agent);
  const session = id(r?.session);
  const turn = id(r?.turn);
  const model = text(r?.model, 100);
  const started = epoch(r?.started_at);
  const ended = epoch(r?.ended_at);
  if (!a || !session || !turn || !model || started === null || ended === null || ended < started) return null;
  const counts = Object.fromEntries(TOKENS.map((k) => [k, int(r[k], 0, 1e12) ?? 0]));
  let tools = null;
  try {
    const t = typeof r.tools === 'string' && r.tools.length <= 4000 ? JSON.parse(r.tools) : null;
    const clean = Object.entries(t && typeof t === 'object' ? t : {}).slice(0, 100).filter(([k, v]) => /^[\w:.-]{1,80}$/.test(k) && int(v, 1, 1e6));
    tools = clean.length ? JSON.stringify(Object.fromEntries(clean)) : null;
  } catch { tools = null; }
  return { agent: a, session, turn, model, account: text(r.account), seat: text(r.seat, 64), project: text(r.project, 120),
    branch: text(r.branch, 200), origin: text(r.origin, 32), client: text(r.client, 64), started_at: started, ended_at: ended,
    calls: int(r.calls, 0, 1e6) ?? 0, ...counts, tools };
}

function parseCost(r) {
  const a = agent(r?.agent);
  const session = id(r?.session);
  const model = text(r?.model, 100);
  const cost = real(r?.cost_usd, 0, 1e6);
  return a && session && model && cost !== null ? { agent: a, session, model, cost_usd: cost } : null;
}

function parseQuota(r) {
  const a = agent(r?.agent);
  const account = text(r?.account);
  const span = typeof r?.span === 'string' && /^\d{1,3}[hd]$/.test(r.span) ? r.span : null;
  const start = epoch(r?.window_start);
  const windowMs = int(r?.window_ms, 60000, 400 * 86400000);
  const used = real(r?.used, 0, 100);
  const at = epoch(r?.observed_at);
  return a && account && span && start !== null && windowMs !== null && used !== null && at !== null
    ? { account, agent: a, span, window_start: start, window_ms: windowMs, used, observed_at: at } : null;
}

function parseResources(r) {
  const hour = epoch(r?.hour);
  const samples = int(r?.samples, 1, 1e5);
  if (hour === null || hour % 3600000 || !samples) return null;
  const b = (v) => real(v, 0, 1e16);
  const pct = (v) => real(v, 0, 100 * samples);
  const out = { hour, samples, cpu_sum: pct(r.cpu_sum), cpu_max: real(r.cpu_max, 0, 100), mem_sum: b(r.mem_sum), mem_max: b(r.mem_max),
    mem_total: b(r.mem_total), gpu_sum: r.gpu_sum == null ? null : pct(r.gpu_sum), gpu_max: r.gpu_max == null ? null : real(r.gpu_max, 0, 100),
    gpu_mem_max: r.gpu_mem_max == null ? null : b(r.gpu_mem_max) };
  return ['cpu_sum', 'cpu_max', 'mem_sum', 'mem_max', 'mem_total'].every((k) => out[k] !== null) ? out : null;
}

const list = (v, parse) => (Array.isArray(v) ? v.slice(0, MAX_USAGE_ROWS).map(parse).filter(Boolean) : []);

/** A host's usage POST body -> {turns, costs, quota, resources} or null. Bad rows are dropped, not fatal. */
export function parseUsageBatch(body) {
  if (!body || body.schemaVersion !== USAGE_SCHEMA_VERSION) return null;
  return { turns: list(body.turns, parseTurn), costs: list(body.costs, parseCost), quota: list(body.quota, parseQuota),
    resources: list(body.resources, parseResources) };
}

// Statements that change anything. REPLACE is also a string function, so only its statement forms count.
const WRITES = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|\bREPLACE\s+INTO\b|\bOR\s+REPLACE\b/i;

/**
 * Whether `sql` is one read-only statement: a SELECT (or WITH ... SELECT), nothing after it.
 * D1 has no read-only role, so this gate is what keeps an analyst — human or AI — from writing.
 * Literals, quoted names and comments are blanked before the check, so a word inside them
 * neither passes nor blocks. -> {ok: true, sql} | {ok: false, error}
 */
export function readOnlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 20000) return { ok: false, error: 'empty or too long' };
  const bare = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  if (/['"]/.test(bare.replace(/''|""/g, ''))) return { ok: false, error: 'unterminated quote' };
  const body = bare.trim().replace(/;\s*$/, '');
  if (body.includes(';')) return { ok: false, error: 'one statement only' };
  if (!/^(SELECT|WITH)\b/i.test(body)) return { ok: false, error: 'read-only: one SELECT or WITH ... SELECT' };
  if (WRITES.test(body)) return { ok: false, error: 'read-only: no statement that writes' };
  return { ok: true, sql: sql.trim().replace(/;\s*$/, '') };
}
