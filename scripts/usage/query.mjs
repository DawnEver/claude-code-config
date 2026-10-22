#!/usr/bin/env node
// scripts/usage/query.mjs — read-only SQL over the usage store (docs/usage.md), for a human or an
// AI on any host that pushes to the dashboard: it signs in with this host's dashboard token.
//
//   npm run usage -- schema               every table and view, with its column comments
//   npm run usage -- "SELECT ..."         one SELECT / WITH statement; prints a table
//   npm run usage -- --json "SELECT ..."  the same as JSON {columns, rows, truncated}

import { isMain } from '../shared/is-main.mjs';
import { readMachineName } from '../shared/machine.mjs';
import { readBridgeConfig } from '../bridge/context.mjs';

export const SCHEMA_SQL = "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE '\_%' ESCAPE '\' AND name NOT LIKE 'sqlite%' AND name NOT LIKE 'd1_%' ORDER BY type, name";

/** {columns, rows} -> an aligned text table. */
export function table({ columns, rows }) {
  const cells = [columns, ...rows].map((r) => r.map((v) => (v === null ? '' : String(v))));
  const w = columns.map((_, i) => Math.min(60, Math.max(...cells.map((r) => r[i].length))));
  const line = (r) => r.map((v, i) => (v.length > w[i] ? `${v.slice(0, w[i] - 1)}~` : v.padEnd(w[i]))).join('  ').trimEnd();
  return [line(cells[0]), w.map((n) => '-'.repeat(n)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

export async function run(sql, { fetch = globalThis.fetch, config = readBridgeConfig(), machine = readMachineName() } = {}) {
  if (!config.dashboard) throw new Error(`no dashboard on this host: ${config.dashboardError ?? 'bridge.dashboard is not configured'} (docs/dashboard.md)`);
  const res = await fetch(`${config.dashboard.url}/api/hosts/${machine}/query`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.dashboard.hostToken}` }, body: JSON.stringify({ sql }) });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (out.error) throw new Error(typeof out.error === 'string' ? out.error : out.error.code ?? `HTTP ${res.status}`);
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const asJson = argv[0] === '--json';
  const arg = (asJson ? argv.slice(1) : argv).join(' ').trim();
  if (!arg) throw new Error('usage: npm run usage -- schema | [--json] "SELECT ..."');
  if (arg === 'schema') {
    const { rows } = await run(SCHEMA_SQL);
    console.log(rows.map(([, , sql]) => `${sql};`).join('\n\n'));
    return;
  }
  const out = await run(arg);
  console.log(asJson ? JSON.stringify(out) : `${table(out)}\n(${out.rows.length} rows${out.truncated ? ', truncated' : ''})`);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
