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

const SQL = {
  turn: insert('turns', TURN_COLS, 'agent, session, turn, model',
    TURN_COLS.filter((c) => !['agent', 'session', 'turn', 'model'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')),
  cost: insert('session_costs', ['agent', 'session', 'model', 'machine', 'cost_usd', 'updated_at'], 'agent, session, model',
    'cost_usd = excluded.cost_usd, machine = excluded.machine, updated_at = excluded.updated_at'),
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

const TOKENS = 'SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(output) AS output';

/**
 * The Usage tab's report over the last `days` days, by day on the viewer's clock (`tzOffsetMin`,
 * minutes east of UTC): per day and agent, and per project, model and machine over the range.
 * `days: 1` is the last 24 hours instead, by hour (`unit: 'hour'`, `day` then 'YYYY-MM-DDTHH').
 * `active_ms` sums turn durations: agent time, so parallel sessions add up.
 */
export async function report(db, { days = 30, tzOffsetMin = 0, now = Date.now() } = {}) {
  const off = tzOffsetMin * 60000;
  const unit = days === 1 ? 'hour' : 'day';
  const ms = unit === 'hour' ? 3600000 : 86400000;
  const buckets = unit === 'hour' ? 24 : days;
  const since = Math.floor((now + off) / ms - buckets + 1) * ms - off;
  const fmt = unit === 'hour' ? "strftime('%Y-%m-%dT%H', (started_at + ?) / 1000, 'unixepoch')" : "date((started_at + ?) / 1000, 'unixepoch')";
  const all = (sql, ...args) => db.prepare(sql).bind(...args).all().then((r) => r.results);
  const by = (col, limit) => all(`SELECT ${col} AS k, ${TOKENS}, SUM(ended_at - started_at) AS active_ms, COUNT(DISTINCT session) AS sessions, COUNT(*) AS turns
    FROM turns WHERE started_at >= ? GROUP BY ${col} ORDER BY SUM(input + cache_read + cache_write + output) DESC LIMIT ${limit}`, since);
  const [daily, projects, models, machines, cost] = await Promise.all([
    all(`SELECT ${fmt} AS day, agent, ${TOKENS}, SUM(ended_at - started_at) AS active_ms, COUNT(*) AS turns
      FROM turns WHERE started_at >= ? GROUP BY day, agent ORDER BY day`, off, since),
    by('project', 12), by('model', 12), by('machine', 12),
    all(`SELECT SUM(cost_usd) AS usd FROM session_costs WHERE session IN (SELECT DISTINCT session FROM turns WHERE started_at >= ?)`, since),
  ]);
  return { days, unit, since, daily, projects, models, machines, costUsd: cost[0]?.usd ?? null };
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
