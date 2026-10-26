import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { claudeTranscript, codexTranscript } from './transcripts.mjs';
import { UsageScanner, sources } from './scan.mjs';
import { HourlyResources, UsagePush, quotaRows } from './push.mjs';
import { table } from './query.mjs';
import { parseUsageBatch, readOnlySql, USAGE_SCHEMA_VERSION } from '../shared/usage-schema.mjs';
import { ingest, query, report } from '../dashboard/usage-store.mjs';
import { createApi } from '../dashboard/api.mjs';
import { newHostToken } from '../dashboard/auth.mjs';
import { bindUsageDb } from '../dashboard/deploy.mjs';

const T0 = Date.parse('2026-10-20T10:00:00Z');

test('explicit homes scope Codex transcript roots and unknown-account attribution', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-homes-'));
  try {
    const one = sources(home, { codexHome: path.join(home, 'one'), machine: 'host' }).filter(s => s.agent === 'codex');
    const two = sources(home, { codexHome: path.join(home, 'two'), machine: 'host' }).filter(s => s.agent === 'codex');
    assert.equal(one.length, 2);
    assert.equal(one[0].root, path.join(home, 'one', 'sessions'));
    assert.equal(one[1].root, path.join(home, 'one', 'archived_sessions'));
    assert.notEqual(one[0].account(), two[0].account());
    assert.doesNotMatch(one[0].account(), /usage-homes/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
const iso = (dt) => new Date(T0 + dt).toISOString();
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

const prompt = (uuid, dt, over = {}) => ({ type: 'user', uuid, sessionId: 'S1', timestamp: iso(dt), cwd: '/w/proj', gitBranch: 'feat/x',
  entrypoint: 'cli', turnOrigin: 'human', message: { role: 'user', content: 'do it' }, ...over });
const call = (id, dt, { model = 'claude-opus-5-5', out = 10, tool } = {}) => ({ type: 'assistant', uuid: `a-${id}-${dt}`, sessionId: 'S1', timestamp: iso(dt),
  message: { id, model, content: tool ? [{ type: 'tool_use', id: `tu-${id}`, name: tool }] : [{ type: 'text', text: 'secret answer' }],
    usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: out, output_tokens_details: { thinking_tokens: 3 } } } });
const toolResult = (dt) => ({ type: 'user', uuid: `r${dt}`, sessionId: 'S1', timestamp: iso(dt), toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } });

test('claude transcript: one row per turn and model; a streamed call counts once, at its last usage; no text', () => {
  const r = claudeTranscript(jsonl([
    prompt('p1', 0),
    call('m1', 1000, { out: 5, tool: 'Bash' }), call('m1', 1500, { out: 9, tool: 'Bash' }),   // one call streamed as two entries
    toolResult(2000),
    call('m2', 3000, { model: 'claude-haiku-5-5' }),
    { type: 'user', uuid: 'meta', isMeta: true, timestamp: iso(3500), message: { content: 'injected' } },
    prompt('p2', 60000, { turnOrigin: 'task_notification' }),
    call('m3', 61000),
    { type: 'assistant', timestamp: iso(62000), message: { id: 'x', model: '<synthetic>', usage: { output_tokens: 1 } } },
    { type: 'cost-state', modelUsage: { 'claude-opus-5-5': { costUSD: 1.5 }, 'claude-haiku-5-5': { costUSD: 0 } } },
    'not json',
  ].map((e) => (typeof e === 'string' ? e : e)).filter((e) => typeof e === 'object')) + 'not json\n');
  assert.equal(r.session, 'S1');
  assert.deepEqual(r.costs, [{ model: 'claude-opus-5-5', cost_usd: 1.5 }]);
  const [opus, haiku, next] = r.turns;
  assert.deepEqual({ ...opus }, { turn: 'p1', started_at: T0, ended_at: T0 + 3000, origin: 'human', client: 'cli', branch: 'feat/x', cwd: '/w/proj',
    model: 'claude-opus-5-5', calls: 1, input: 2, cache_read: 100, cache_write: 50, output: 9, reasoning: 3, tools: '{"Bash":1}' });
  assert.equal(haiku.model, 'claude-haiku-5-5');
  assert.equal(haiku.tools, null, 'a turn\'s tools go on its first row only');
  assert.equal(haiku.ended_at, T0 + 3000);
  assert.equal(next.origin, 'task');
  assert.equal(r.turns.length, 3);
  assert.ok(!JSON.stringify(r).includes('secret answer') && !JSON.stringify(r).includes('do it'));
});

test('claude transcript: a subagent run is one turn of its parent session', () => {
  const r = claudeTranscript(jsonl([prompt('q', 0, { agentId: 'ag1', isSidechain: true }), call('m', 100), prompt('q2', 200, { agentId: 'ag1' }), call('n', 300)]), { subagent: true });
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].turn, 'ag1:q');
  assert.equal(r.turns[0].origin, 'subagent');
  assert.equal(r.turns[0].calls, 2);
});

const codexMeta = { timestamp: iso(0), type: 'session_meta', payload: { id: 'C1', cwd: '/w/repo', originator: 'codex_cli_rs', source: 'cli',
  git: { branch: 'main', repository_url: 'git@github.com:o/repo.git' } } };
const usage = (input, cached, out, reasoning) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: reasoning, total_tokens: input + out });

test('codex rollout: per-response records by turn; input normalised to its uncached part', () => {
  const r = codexTranscript(jsonl([
    codexMeta,
    { timestamp: iso(10), type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { timestamp: iso(11), type: 'turn_context', payload: { turn_id: 'T1', model: 'gpt-6', cwd: '/w/repo' } },
    { timestamp: iso(12), type: 'event_msg', payload: { type: 'user_message', message: 'secret prompt' } },
    { timestamp: iso(20), type: 'response_item', payload: { type: 'function_call', name: 'exec' } },
    { timestamp: iso(30), type: 'token_usage_record', payload: { turn_id: 'T1', usage: usage(1000, 800, 50, 20) } },
    { timestamp: iso(31), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(1000, 800, 50, 20), total_token_usage: usage(1000, 800, 50, 20) } } },
    { timestamp: iso(40), type: 'token_usage_record', payload: { turn_id: 'T1', usage: usage(500, 0, 5, 0) } },
    { timestamp: iso(50), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', last_agent_message: 'secret' } },
  ]));
  assert.equal(r.session, 'C1');
  assert.equal(r.repositoryUrl, 'git@github.com:o/repo.git');
  assert.deepEqual(r.turns, [{ turn: 'T1', started_at: T0 + 10, ended_at: T0 + 50, origin: 'human', client: 'codex_cli_rs/cli', branch: 'main', cwd: '/w/repo',
    model: 'gpt-6', calls: 2, input: 700, cache_read: 800, cache_write: 0, output: 55, reasoning: 20, tools: '{"exec":1}' }]);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('codex rollout without records: token_count counted when the running total moves', () => {
  const tc = (dt, total) => ({ timestamp: iso(dt), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage(100, 0, 10, 0), total_token_usage: { total_tokens: total } } } });
  const r = codexTranscript(jsonl([codexMeta, { timestamp: iso(1), type: 'turn_context', payload: { turn_id: 'T', model: 'm' } }, tc(2, 110), tc(3, 110), tc(4, 220)]));
  assert.equal(r.turns[0].calls, 2);
  assert.equal(r.turns[0].input, 200);
  assert.equal(r.turns[0].origin, 'system', 'no user message: not a human turn');
});

test('a collector login change never relabels historical Codex turns as the currently signed-in account', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-account-switch-'));
  try {
    const codexHome = path.join(home, 'custom');
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'sessions', 'history.jsonl'), jsonl([
      codexMeta,
      { timestamp: iso(10), type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
      { timestamp: iso(11), type: 'turn_context', payload: { turn_id: 'T1', model: 'gpt-6' } },
      { timestamp: iso(20), type: 'token_usage_record', payload: { turn_id: 'T1', usage: usage(100, 0, 5, 0) } },
    ]));
    const collect = email => new UsageScanner({ cursorFile: path.join(home, `${email}.cursor`), project: () => 'repo',
      sources: () => sources(home, { codexHome, machine: 'host', codexEmail: () => email }) }).collect();
    const before = await collect('one@example.com');
    const after = await collect('two@example.com');
    assert.equal(before.turns.length, 1);
    assert.deepEqual(before.turns.map(t => t.account), after.turns.map(t => t.account));
    assert.match(before.turns[0].account, /^codex:host\/home-[0-9a-f]{16}$/);
    assert.doesNotMatch(before.turns[0].account, /example\.com/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-')); }

test('scanner: sends what is new, resends the last sent turn, forgets deleted files, never sends a cwd', async () => {
  const dir = tmpdir();
  const root = path.join(dir, 'projects', 'p');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'S1.jsonl');
  fs.writeFileSync(file, jsonl([prompt('p1', 0), call('m1', 10)]));
  const cursorFile = path.join(dir, 'cursor.json');
  const projects = [];
  const make = () => new UsageScanner({ cursorFile, project: (cwd) => { projects.push(cwd); return 'proj'; },
    sources: () => [{ agent: 'claude', root: path.join(dir, 'projects'), depth: 3, seat: 'team', account: () => 'claude:a|o' }] });
  let s = make();
  let b = await s.collect();
  assert.equal(b.turns.length, 1);
  assert.deepEqual({ agent: b.turns[0].agent, session: b.turns[0].session, account: b.turns[0].account, seat: b.turns[0].seat, project: b.turns[0].project },
    { agent: 'claude', session: 'S1', account: 'claude:a|o', seat: 'team', project: 'proj' });
  assert.ok(!('cwd' in b.turns[0]));
  b.commit();
  assert.equal((await s.collect()).turns.length, 0, 'unchanged file: nothing');
  fs.appendFileSync(file, jsonl([call('m2', 20), prompt('p2', 100), call('m3', 110)]));
  s = make();   // a restarted daemon reads the cursor back
  b = await s.collect();
  assert.deepEqual(b.turns.map((t) => [t.turn, t.calls]), [['p1', 2], ['p2', 1]], 'the last sent turn again (it grew), then the new one');
  b.commit();
  assert.deepEqual(projects, ['/w/proj'], 'a cwd\'s project is resolved once, then cached in the cursor');
  fs.rmSync(file);
  (await s.collect()).commit();
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).files, {});
});

test('scanner: a limit cuts at a whole file and reports more', async () => {
  const dir = tmpdir();
  const root = path.join(dir, 'projects', 'p');
  fs.mkdirSync(root, { recursive: true });
  for (const n of ['a', 'b']) fs.writeFileSync(path.join(root, `${n}.jsonl`), jsonl([prompt('p', 0, { sessionId: n }), call('m', 1)].map((e) => ({ ...e, sessionId: n }))));
  const s = new UsageScanner({ cursorFile: path.join(dir, 'c.json'), project: () => null,
    sources: () => [{ agent: 'claude', root: path.join(dir, 'projects'), depth: 3, seat: null, account: () => null }] });
  const b1 = await s.collect({ limit: 1 });
  assert.equal(b1.turns.length, 1);
  assert.equal(b1.more, true);
  b1.commit();
  const b2 = await s.collect({ limit: 1 });
  assert.equal(b2.turns.length, 1);
  b2.commit();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'c.json'), 'utf8')).files).length, 2, 'a cut-short walk forgot nothing');
});

test('hourly resources: completed hours only, sums and maxima', () => {
  const h = new HourlyResources();
  const H = 3600000;
  const r = (cpu, used, gpus = []) => ({ cpu, mem: { used, total: 100 }, gpus });
  h.add(r(10, 40, [{ util: 50, memUsed: 7 }, { util: 90, memUsed: 3 }]), 5 * H + 1);
  h.add(r(30, 60), 5 * H + 2);
  assert.deepEqual(h.take(), [], 'the hour is still open');
  h.add(r(5, 1), 6 * H);
  assert.deepEqual(h.take(), [{ hour: 5 * H, samples: 2, cpu_sum: 40, cpu_max: 30, mem_sum: 100, mem_max: 60, mem_total: 100, gpu_sum: 90, gpu_max: 90, gpu_mem_max: 7 }]);
});

test('quota rows: current windows only, opening rounded so jitter lands on one row', () => {
  const NOW = T0;
  const rows = quotaRows([{ key: 'claude:a|o', agent: 'claude', at: NOW, windows: [
    { k: '5h', used: 40, resetsAt: NOW + 3600000 + 61000, windowMs: 5 * 3600000 },
    { k: '7d', used: 0, resetsAt: null, windowMs: 7 * 86400000 },
  ] }], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].window_start, NOW - 4 * 3600000);
});

test('readOnlySql: one SELECT, nothing that writes, literals and comments do not count', () => {
  for (const ok of ['SELECT 1', 'select * from turns;', "SELECT replace(model, 'x', 'y') FROM turns", "SELECT 'drop table turns' AS s",
    'WITH t AS (SELECT 1) SELECT * FROM t', 'SELECT "update" FROM x -- delete', 'SELECT 1 /* ; insert */']) {
    assert.equal(readOnlySql(ok).ok, true, ok);
  }
  for (const bad of ['DELETE FROM turns', 'SELECT 1; DROP TABLE turns', 'WITH t AS (SELECT 1) DELETE FROM turns', 'PRAGMA table_info(turns)',
    'INSERT OR REPLACE INTO turns VALUES (1)', "SELECT 'unterminated", '', 'ATTACH DATABASE x AS y', 'WITH x AS (SELECT 1) REPLACE INTO t VALUES (1)']) {
    assert.equal(readOnlySql(bad).ok, false, bad);
  }
});

const turnRow = (over = {}) => ({ agent: 'claude', session: 'S1', turn: 'p1', model: 'claude-opus-5-5', account: 'claude:a|o', seat: null, project: 'proj',
  branch: 'main', origin: 'human', client: 'cli', started_at: T0, ended_at: T0 + 60000, calls: 3, input: 10, cache_read: 1000, cache_write: 100, output: 50,
  reasoning: 5, tools: '{"Bash":2}', ...over });

test('parseUsageBatch: whitelists and bounds; a bad row is dropped, a wrong version refused', () => {
  const b = parseUsageBatch({ schemaVersion: USAGE_SCHEMA_VERSION, turns: [turnRow({ cwd: '/home/u', text: 'x' }), turnRow({ agent: 'gpt' }),
    turnRow({ ended_at: T0 - 1 }), turnRow({ tools: '{"Bad Name!":1,"Read":2}' })], costs: [{ agent: 'claude', session: 'S1', model: 'm', cost_usd: -1 }] });
  assert.equal(b.turns.length, 2);
  assert.ok(!('cwd' in b.turns[0]) && !('text' in b.turns[0]));
  assert.equal(b.turns[1].tools, '{"Read":2}');
  assert.deepEqual(b.costs, []);
  assert.equal(parseUsageBatch({ schemaVersion: 99 }), null);
});

/** D1's API over node:sqlite, with the real migrations. */
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../dashboard/migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    raw: async ({ columnNames = false } = {}) => {
      const s = db.prepare(sql);
      const rows = s.all(...args).map((r) => Object.values(r));
      return columnNames ? [s.columns().map((c) => c.name), ...rows] : rows;
    },
  });
  return {
    sqlite: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { for (const s of stmts) db.prepare(s.sql).run(...s.args); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

test('store: turns upsert by key, quota keeps its highest reading, an hour two daemons sampled sums', async () => {
  const db = fakeD1();
  const empty = { turns: [], costs: [], quota: [], resources: [] };
  await ingest(db, 'host-a', { ...empty, turns: [turnRow(), turnRow({ turn: 'p2', started_at: T0 + 120000, ended_at: T0 + 130000 })] });
  await ingest(db, 'host-a', { ...empty, turns: [turnRow({ calls: 4, output: 70 })] });   // the turn grew
  assert.deepEqual(db.sqlite.prepare('SELECT turn, calls, output, machine FROM turns ORDER BY turn').all().map((r) => ({ ...r })),
    [{ turn: 'p1', calls: 4, output: 70, machine: 'host-a' }, { turn: 'p2', calls: 3, output: 50, machine: 'host-a' }]);
  const gap = db.sqlite.prepare("SELECT gap_ms, active_ms FROM turn_times WHERE turn = 'p2'").get();
  assert.deepEqual({ ...gap }, { gap_ms: 60000, active_ms: 10000 });
  const q = (used) => ({ account: 'claude:a|o', agent: 'claude', span: '5h', window_start: T0, window_ms: 18000000, used, observed_at: T0 });
  await ingest(db, 'host-a', { ...empty, quota: [q(40)] });
  await ingest(db, 'host-b', { ...empty, quota: [q(30)] });
  assert.equal(db.sqlite.prepare('SELECT used FROM quota_windows').get().used, 40);
  const res = { hour: 3600000 * 500000, samples: 2, cpu_sum: 20, cpu_max: 15, mem_sum: 10, mem_max: 6, mem_total: 8, gpu_sum: null, gpu_max: null, gpu_mem_max: null };
  await ingest(db, 'host-a', { ...empty, resources: [res] });
  await ingest(db, 'host-a', { ...empty, resources: [{ ...res, cpu_max: 50 }] });
  assert.deepEqual({ ...db.sqlite.prepare('SELECT samples, cpu_avg, cpu_max FROM resources_hourly').get() }, { samples: 4, cpu_avg: 10, cpu_max: 50 });
  await ingest(db, 'host-a', { ...empty, costs: [{ agent: 'claude', session: 'S1', model: 'claude-opus-5-5', cost_usd: 2.5 }] });
  assert.equal(db.sqlite.prepare("SELECT cost_usd FROM sessions WHERE session = 'S1'").get().cost_usd, 2.5);
});

test('store: report by the viewer\'s day; query is read-only and capped', async () => {
  const db = fakeD1();
  const empty = { costs: [], quota: [], resources: [] };
  await ingest(db, 'host-a', { ...empty, turns: [turnRow({ started_at: Date.parse('2026-10-20T23:30:00Z'), ended_at: Date.parse('2026-10-20T23:40:00Z') }),
    turnRow({ turn: 'c', agent: 'codex', session: 'C1', model: 'gpt-6', project: 'other', output: 1, started_at: Date.parse('2026-10-21T12:00:00Z'), ended_at: Date.parse('2026-10-21T12:01:00Z') })] });
  const r = await report(db, { days: 7, tzOffsetMin: 60, now: Date.parse('2026-10-21T13:00:00Z') });
  assert.deepEqual(r.daily.map((d) => [d.day, d.agent, d.active_ms]), [['2026-10-21', 'claude', 600000], ['2026-10-21', 'codex', 60000]], '23:30 UTC is the 21st at UTC+1');
  assert.deepEqual(r.projects.map((p) => p.k), ['proj', 'other']);
  const h = await report(db, { days: 1, tzOffsetMin: 60, now: Date.parse('2026-10-21T13:00:00Z') });
  assert.equal(h.unit, 'hour');
  assert.deepEqual(h.daily.map((d) => [d.day, d.agent]), [['2026-10-21T00', 'claude'], ['2026-10-21T13', 'codex']], '24 h by the viewer hour');
  const old = await report(db, { days: 1, now: Date.parse('2026-10-22T13:00:00Z') });
  assert.deepEqual(old.daily, [], 'older than 24 h is out');
  assert.equal(r.machines[0].k, 'host-a');
  const ok = await query(db, 'SELECT agent, COUNT(*) AS n FROM turns GROUP BY agent ORDER BY agent');
  assert.deepEqual(ok, { columns: ['agent', 'n'], rows: [['claude', 1], ['codex', 1]], truncated: false });
  assert.match((await query(db, 'DELETE FROM turns')).error, /read-only/);
  assert.match((await query(db, 'SELECT nope FROM turns')).error, /nope/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 2);
  const schema = await query(db, "SELECT sql FROM sqlite_master WHERE name = 'turns'");
  assert.match(schema.rows[0][0], /uncached input tokens/, 'the schema explains itself');
});

test('api: usage and query only for the host by its token; the store absent is a 503', async () => {
  const { token, hash } = await newHostToken();
  const config = { botId: 1, allowedUserIds: [1], hosts: { 'host-a': hash }, publicKey: '00', ttlSeconds: 60, initDataMaxAgeSeconds: 60, ratePerMinute: 1000 };
  const db = fakeD1();
  const api = createApi(config, { db, now: () => T0 });
  const post = (p, body, auth = `Bearer ${token}`, a = api) => a(new Request(`https://d.example/api/hosts/${p}`, { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) }));
  const batch = { schemaVersion: USAGE_SCHEMA_VERSION, turns: [turnRow()] };
  assert.equal((await post('host-b/usage', batch)).status, 401);
  assert.equal((await post('host-a/usage', batch, 'Bearer nope-nope-nope-nope')).status, 401);
  const res = await post('host-a/usage', batch);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).stored, { turns: 1, costs: 0, quota: 0, resources: 0 });
  assert.equal(db.sqlite.prepare('SELECT machine FROM turns').get().machine, 'host-a', 'the machine is the authenticated host, never the body');
  assert.equal((await post('host-a/usage', { schemaVersion: 0 })).status, 400);
  const q = await post('host-a/query', { sql: 'SELECT COUNT(*) AS n FROM turns' });
  assert.deepEqual((await q.json()).rows, [[1]]);
  assert.equal((await post('host-a/query', { sql: 'DROP TABLE turns' })).status, 400);
  assert.equal((await post('host-a/usage', batch, undefined, createApi(config, { now: () => T0 }))).status, 503);
  assert.equal((await api(new Request('https://d.example/api/usage'))).status, 401, 'the report is for an allowlisted viewer');
});

test('push: quota and hours once, turns in chunks, the cursor moves only after acceptance', async () => {
  const posted = [];
  let fail = false;
  const fetch = async (url, init) => { if (fail) return new Response('', { status: 500 }); posted.push(JSON.parse(init.body)); return new Response('{}'); };
  const commits = [];
  const turns = Array.from({ length: 300 }, (_, i) => turnRow({ turn: `t${i}` }));
  let left = [turns];
  const scanner = { collect: async () => { const t = left.shift() ?? []; return { turns: t, costs: [], more: left.length > 0, commit: () => commits.push(t.length) }; } };
  const push = new UsagePush({ url: 'https://d.example', hostToken: 'x', machine: 'host-a', scanner, fetch, now: () => T0 + 7200000,
    accounts: () => [{ key: 'k', agent: 'codex', at: T0, windows: [{ k: '7d', used: 5, resetsAt: T0 + 86400000, windowMs: 7 * 86400000 }] }] });
  push.sample({ cpu: 1, mem: { used: 1, total: 2 }, gpus: [] });
  push.hourly.add({ cpu: 1, mem: { used: 1, total: 2 }, gpus: [] }, T0 + 4 * 3600000);   // closes the hour
  assert.equal(await push.tick(), true);
  assert.deepEqual(posted.map((b) => [b.quota.length, b.resources.length, b.turns.length]), [[1, 1, 0], [0, 0, 250], [0, 0, 50]]);
  assert.deepEqual(commits, [300]);
  fail = true;
  left = [[turnRow()]];
  assert.equal(await push.tick(), false);
  assert.deepEqual(commits, [300], 'refused: the cursor stays');
});

test('query CLI table and the wrangler binding', () => {
  assert.equal(table({ columns: ['a', 'bb'], rows: [[1, null], ['xyz', 2]] }), 'a    bb\n---  --\n1\nxyz  2');
  const base = '{\n  "durable_objects": { "bindings": [] },\n  "x": 1\n}';
  const once = bindUsageDb(base, 'id-1');
  assert.match(once, /"database_id": "id-1"/);
  assert.equal(bindUsageDb(once, 'id-2').match(/d1_databases/g).length, 1, 'rebinding replaces');
  assert.match(bindUsageDb(once, 'id-2'), /"id-2"/);
});

test('usage view: every day of the range, split by agent; ranked lists with shares; demo masks names', async () => {
  const { usageView, tokenText, hoursText } = await import('../dashboard/public/view.mjs');
  const { demoMasker } = await import('../dashboard/public/demo.mjs');
  const report = { days: 3, daily: [{ day: '2026-10-21', agent: 'claude', input: 10, cache_read: 80, cache_write: 10, output: 0, active_ms: 3600000, turns: 2 },
    { day: '2026-10-21', agent: 'codex', input: 50, cache_read: 0, cache_write: 0, output: 50, active_ms: 0, turns: 1 }],
  projects: [{ k: 'secret-proj', input: 200, cache_read: 0, cache_write: 0, output: 0, active_ms: 5, turns: 3, sessions: 1 }], models: [], machines: [{ k: 'host-a', input: 1 }], costUsd: 4.2 };
  const v = usageView(report, Date.parse('2026-10-21T12:00:00Z'));
  assert.deepEqual(v.days.map((d) => [d.day, d.claude, d.codex]), [['2026-10-19', 0, 0], ['2026-10-20', 0, 0], ['2026-10-21', 100, 100]]);
  assert.equal(v.days[2].claudePct, 50);
  assert.deepEqual(v.totals, { tokens: 200, active: 3600000, turns: 3, costUsd: 4.2, cacheHit: 80 / 150 });
  assert.equal(v.projects[0].share, 1);
  assert.deepEqual([tokenText(950), tokenText(12345), tokenText(3.45e6), tokenText(0)], ['950', '12k', '3.5M', '0']);
  assert.deepEqual([hoursText(45 * 60000), hoursText(3.5 * 3600000), hoursText(0)], ['45m', '3.5h', '0']);
  const hv = usageView({ days: 1, unit: 'hour', daily: [{ day: '2026-10-21T11', agent: 'claude', input: 5, cache_read: 0, cache_write: 0, output: 0, turns: 1 }] },
    Date.parse('2026-10-21T12:30:00Z'));
  assert.equal(hv.unit, 'hour');
  assert.equal(hv.days.length, 24);
  assert.deepEqual([hv.days[0].day, hv.days.at(-2).day, hv.days.at(-2).claude, hv.days.at(-1).day], ['2026-10-20T13', '2026-10-21T11', 5, '2026-10-21T12']);
  const masked = demoMasker().usage(report);
  assert.equal(masked.projects[0].k, 'project-a');
  assert.equal(masked.machines[0].k, 'Workstation 1');
});

test('scanner: an agent worktree is its repo\'s project', () => {
  const seen = [];
  const s = new UsageScanner({ cursorFile: path.join(tmpdir(), 'c.json'), sources: () => [], project: (cwd) => { seen.push(cwd); return cwd.split(/[\\/]/).pop(); } });
  assert.equal(s.projectOf(String.raw`C:\w\repo\.claude\worktrees\agent-a1\sub`), 'repo');
  assert.equal(s.projectOf('/w/repo/.claude/worktrees/x'), 'repo');
  assert.equal(s.projectOf('/w/other', 'git@h:o/named.git'), 'named', 'Codex names its repo itself');
});

test('codex rollout: a user-role message marks a human turn', () => {
  const r = codexTranscript(jsonl([codexMeta, { timestamp: iso(1), type: 'turn_context', payload: { turn_id: 'T', model: 'm' } },
    { timestamp: iso(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
    { timestamp: iso(3), type: 'token_usage_record', payload: { turn_id: 'T', usage: usage(1, 0, 1, 0) } }]));
  assert.equal(r.turns[0].origin, 'human');
});
