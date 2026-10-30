// scripts/dashboard/usage-store.mjs — the usage store on D1 (docs/usage.md): the one place usage
// is kept for months, read by the Mini App's Usage tab and by any analyst (a human or an AI) via
// read-only SQL. Its schema, with every column described, is scripts/dashboard/migrations/*.sql.
// `db` is a D1 binding (in Node tests, the same API over node:sqlite).

import { readOnlySql } from '../shared/usage-schema.mjs';

const TURN_COLS = ['agent', 'session', 'turn', 'model', 'machine', 'account', 'seat', 'project', 'branch', 'origin', 'client',
  'started_at', 'ended_at', 'calls', 'input', 'cache_read', 'cache_write', 'output', 'reasoning', 'tools'];
const RES_COLS = ['machine', 'hour', 'samples', 'cpu_sum', 'cpu_max', 'mem_sum', 'mem_max', 'mem_total', 'gpu_sum', 'gpu_max', 'gpu_mem_max'];

const insert = (table, cols, conflict, update) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
  ON CONFLICT (${conflict}) DO UPDATE SET ${update}`;

const TURN_VALUES = TURN_COLS.filter((c) => !['agent', 'session', 'turn', 'model'].includes(c));

const SQL = {
  // A re-sent turn that did not change is no write (nor a usage_hours trigger).
  turn: insert('turns', TURN_COLS, 'agent, session, turn, model', `${TURN_VALUES.map((c) => `${c} = excluded.${c}`).join(', ')}
  WHERE (${TURN_VALUES.map((c) => `turns.${c}`).join(', ')}) IS NOT (${TURN_VALUES.map((c) => `excluded.${c}`).join(', ')})`),
  // updated_at is when the price last changed (not the report's range test: see report).
  cost: insert('session_costs', ['agent', 'session', 'model', 'machine', 'cost_usd', 'updated_at'], 'agent, session, model',
    'cost_usd = excluded.cost_usd, machine = excluded.machine, updated_at = excluded.updated_at WHERE session_costs.cost_usd IS NOT excluded.cost_usd'),
  // Use only grows within a window: keep the highest reading.
  quota: insert('quota_windows', ['account', 'agent', 'span', 'window_start', 'window_ms', 'used', 'observed_at'], 'account, span, window_start',
    'used = MAX(used, excluded.used), observed_at = MAX(observed_at, excluded.observed_at)'),
  // An hour two daemons sampled (a hand-over) is the sum of both.
  resources: insert('resources', RES_COLS, 'machine, hour',
    'samples = samples + excluded.samples, cpu_sum = cpu_sum + excluded.cpu_sum, cpu_max = MAX(cpu_max, excluded.cpu_max), '
    + 'mem_sum = mem_sum + excluded.mem_sum, mem_max = MAX(mem_max, excluded.mem_max), mem_total = excluded.mem_total, '
    + 'gpu_sum = COALESCE(gpu_sum, 0) + COALESCE(excluded.gpu_sum, 0), gpu_max = MAX(COALESCE(gpu_max, 0), COALESCE(excluded.gpu_max, 0)), '
    + 'gpu_mem_max = MAX(COALESCE(gpu_mem_max, 0), COALESCE(excluded.gpu_mem_max, 0))'),
};

/** Store one parsed batch (scripts/shared/usage-schema.mjs parseUsageBatch) from `machine`, atomically. */
export async function ingest(db, machine, batch, now = Date.now()) {
  const stmts = [
    ...batch.turns.map((r) => db.prepare(SQL.turn).bind(...TURN_COLS.map((c) => (c === 'machine' ? machine : r[c])))),
    ...batch.costs.map((r) => db.prepare(SQL.cost).bind(r.agent, r.session, r.model, machine, r.cost_usd, now)),
    ...batch.quota.map((r) => db.prepare(SQL.quota).bind(r.account, r.agent, r.span, r.window_start, r.window_ms, r.used, r.observed_at)),
    ...batch.resources.map((r) => db.prepare(SQL.resources).bind(...RES_COLS.map((c) => (c === 'machine' ? machine : r[c])))),
  ];
  if (stmts.length) await db.batch(stmts);
  return { turns: batch.turns.length, costs: batch.costs.length, quota: batch.quota.length, resources: batch.resources.length };
}

const SUMS = ['input', 'cache_read', 'cache_write', 'output', 'active_ms', 'turns'];

/** Rows summed by `keyOf` -> [{k, ...SUMS}], first-seen order. */
function rollup(rows, keyOf, extra = () => ({})) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const acc = out.get(k) ?? { k, ...extra(r), ...Object.fromEntries(SUMS.map((c) => [c, 0])) };
    for (const c of SUMS) acc[c] += r[c];
    out.set(k, acc);
  }
  return [...out.values()];
}

const tokens = (r) => r.input + r.cache_read + r.cache_write + r.output;

/**
 * The Usage tab's report over the last `days` days, by day on the viewer's clock (`tzOffsetMin`,
 * minutes east of UTC): per day and agent, and per project, model and machine over the range.
 * `days: 1` is the last 24 hours instead, by hour (`unit: 'hour'`, `day` then 'YYYY-MM-DDTHH').
 * `active_ms` sums turn durations: agent time, so parallel sessions add up.
 * Reads usage_hours (UTC hours), never turns: a viewer off a whole-hour offset sees each hour
 * under the local bucket its start falls in.
 */
export async function report(db, { days = 30, tzOffsetMin = 0, now = Date.now() } = {}) {
  const off = tzOffsetMin * 60000;
  const unit = days === 1 ? 'hour' : 'day';
  const ms = unit === 'hour' ? 3600000 : 86400000;
  const buckets = unit === 'hour' ? 24 : days;
  const since = Math.floor((now + off) / ms - buckets + 1) * ms - off;
  const all = (sql, ...args) => db.prepare(sql).bind(...args).all().then((r) => r.results);
  const [hours, cost] = await Promise.all([
    all('SELECT * FROM usage_hours WHERE hour > ?', since - 3600000),
    // A session's price falls in the range its last turn ended in. Not updated_at: that is when
    // the price arrived, so a backfill would put every past session into the current week.
    all(`SELECT SUM(cost_usd) AS usd FROM session_costs c
      WHERE (SELECT MAX(ended_at) FROM turns t WHERE t.agent = c.agent AND t.session = c.session) >= ?`, since),
  ]);
  const label = (hour) => new Date(Math.max(hour, since) + off).toISOString().slice(0, unit === 'hour' ? 13 : 10);
  const daily = rollup(hours, (r) => `${label(r.hour)}|${r.agent}`, (r) => ({ day: label(r.hour), agent: r.agent }))
    .map(({ k, ...r }) => r).sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent));
  const by = (col) => rollup(hours, (r) => r[col]).map((r) => ({ ...r, k: r.k === '' ? null : r.k }))
    .sort((a, b) => tokens(b) - tokens(a)).slice(0, 12);
  return { days, unit, since, daily, projects: by('project'), models: by('model'), machines: by('machine'), costUsd: cost[0]?.usd ?? null };
}

export const MAX_QUERY_ROWS = 5000;

/** One read-only statement (readOnlySql) -> {columns, rows, truncated} | {error}. */
export async function query(db, sql) {
  const gate = readOnlySql(sql);
  if (!gate.ok) return { error: gate.error };
  try {
    const [columns = [], ...rows] = await db.prepare(gate.sql).raw({ columnNames: true });
    return { columns, rows: rows.slice(0, MAX_QUERY_ROWS), truncated: rows.length > MAX_QUERY_ROWS };
  } catch (e) { return { error: String(e.message ?? e).slice(0, 500) }; }
}
