import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, loadConfig, normalize, jaccard, DEFAULTS, guardCall } from './loop-guard-hook.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const NOW = 1_700_000_000_000;
const bash = (command) => ({ tool: 'Bash', input: { command }, now: NOW });

/** Feed a sequence of calls through evaluate(), threading state. */
function run(calls, cfg = loadConfig({})) {
  let entries = [];
  return calls.map((c) => {
    const res = evaluate(entries, c, cfg);
    entries = res.entries;
    return res.verdict;
  });
}

test('defaults: identical warns on #3 and denies from #4', () => {
  const five = Array.from({ length: 5 }, () => bash('npm test'));
  assert.deepEqual(run(five), ['ok', 'ok', 'warn', 'deny', 'deny']);
});

test('defaults: near-identical warns on #4 and denies from #5', () => {
  const near = ['alpha', 'alphb', 'alphc', 'alphd', 'alphe', 'alphf'].map((w) =>
    bash(`grep -rn "${w}" scripts/setup/setup.js --color=never`),
  );
  assert.deepEqual(run(near), ['ok', 'ok', 'ok', 'warn', 'deny', 'deny']);
});

test('distinct calls never trip the guard', () => {
  assert.deepEqual(run([bash('git status'), bash('ls -la /tmp'), bash('node --version')]), [
    'ok',
    'ok',
    'ok',
  ]);
});

test('normalize is insensitive to key order and whitespace', () => {
  assert.equal(normalize({ a: 1, b: '  X   Y ' }), normalize({ b: 'x y', a: 1 }));
});

test('similarity does not fire across different tools', () => {
  const cmd = 'a'.repeat(200);
  assert.deepEqual(
    run([
      { tool: 'Bash', input: { command: cmd }, now: NOW },
      { tool: 'PowerShell', input: { command: cmd }, now: NOW },
    ]),
    ['ok', 'ok'],
  );
});

test('entries outside the window stop counting', () => {
  const cfg = loadConfig({});
  let entries = [];
  for (let i = 0; i < 3; i++) entries = evaluate(entries, bash('npm test'), cfg).entries;
  const later = evaluate(entries, { ...bash('npm test'), now: NOW + cfg.windowMs + 1 }, cfg);
  assert.equal(later.verdict, 'ok');
});

test('env overrides every threshold', () => {
  const cfg = loadConfig({
    CLAUDE_LOOP_GUARD_WARN_AT: '2',
    CLAUDE_LOOP_GUARD_DENY_AT: '3',
    CLAUDE_LOOP_GUARD_SIMILAR_WARN_AT: '2',
    CLAUDE_LOOP_GUARD_SIMILAR_DENY_AT: '3',
    CLAUDE_LOOP_GUARD_WINDOW_MINUTES: '30',
    CLAUDE_LOOP_GUARD_SIMILAR_THRESHOLD: '0.5',
    CLAUDE_LOOP_GUARD_MAX_ENTRIES: '10',
  });
  assert.equal(cfg.windowMs, 30 * 60 * 1000);
  assert.equal(cfg.maxEntries, 10);
  assert.deepEqual(run(Array.from({ length: 3 }, () => bash('npm test')), cfg), [
    'ok',
    'warn',
    'deny',
  ]);
});

test('malformed or absent env falls back to the documented defaults', () => {
  const cfg = loadConfig({ CLAUDE_LOOP_GUARD_DENY_AT: 'banana', CLAUDE_LOOP_GUARD_WARN_AT: '-1' });
  assert.equal(cfg.denyAt, DEFAULTS.denyAt);
  assert.equal(cfg.warnAt, DEFAULTS.warnAt);
  assert.equal(cfg.disable, false);
});

test('a warn threshold above its deny threshold is clamped so it still fires', () => {
  const cfg = loadConfig({ CLAUDE_LOOP_GUARD_WARN_AT: '9', CLAUDE_LOOP_GUARD_DENY_AT: '2' });
  assert.equal(cfg.warnAt, 2);
});

test('exempt list is extensible and disable is honoured', () => {
  const cfg = loadConfig({ CLAUDE_LOOP_GUARD_EXEMPT: 'Grep, Glob' });
  assert.ok(cfg.exempt.has('Grep') && cfg.exempt.has('Glob') && cfg.exempt.has('Monitor'));
  assert.equal(loadConfig({ CLAUDE_LOOP_GUARD_DISABLE: '1' }).disable, true);
  assert.equal(loadConfig({ CLAUDE_LOOP_GUARD_DISABLE: 'true' }).disable, true);
});

test('a deny carries an actionable reason', () => {
  const cfg = loadConfig({});
  let entries = [];
  let res;
  for (let i = 0; i < cfg.denyAt; i++) {
    res = evaluate(entries, bash('npm test'), cfg);
    entries = res.entries;
  }
  assert.equal(res.verdict, 'deny');
  assert.match(res.reason, /Change the approach|different approach/);
});

test('jaccard is 1 for identical sets and 0 for disjoint ones', () => {
  assert.equal(jaccard(new Set(['abc']), new Set(['abc'])), 1);
  assert.equal(jaccard(new Set(['abc']), new Set(['xyz'])), 0);
});

test('shared config works without launcher env; explicit env has defined precedence', () => {
  const shared = { warnAt: 2, denyAt: 3, disable: true, exempt: ['local_wait'] };
  assert.equal(loadConfig({}, shared).denyAt, 3);
  assert.equal(loadConfig({}, shared).disable, true);
  assert.ok(loadConfig({}, shared).exempt.has('local_wait'));
  assert.equal(loadConfig({ HARNESS_LOOP_GUARD_DENY_AT: '8', CLAUDE_LOOP_GUARD_DENY_AT: '6', HARNESS_LOOP_GUARD_DISABLE: 'false' }, shared).denyAt, 8);
  assert.equal(loadConfig({ HARNESS_LOOP_GUARD_DISABLE: 'false' }, shared).disable, false);
});

test('Codex sibling threads do not count against each other and unknown identity fails open', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'guard-thread-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const payload = { session_id: 'root', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const call = thread => guardCall(payload, { host: 'codex', env: thread ? { CODEX_THREAD_ID: thread } : {}, settings: {}, stateDir, now: NOW });
  assert.equal(call('a').verdict, 'ok');
  assert.equal(call('a').verdict, 'ok');
  assert.equal(call('b').verdict, 'ok');
  assert.equal(call('a').verdict, 'warn');
  assert.equal(call(null), null);
  assert.equal(readdirSync(stateDir).length, 2);
});

test('Codex polling tools are exempt', () => {
  for (const name of ['write_stdin', 'wait_agent', 'list_agents', 'sleep', 'request_user_input', 'request_user_input_async'])
    assert.ok(loadConfig({}).exempt.has(name), name);
});

test('qualified native polling tools are exempt without exempting arbitrary providers', t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'guard-qualified-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const call = tool_name => guardCall({ thread_id: 'qualified', tool_name, tool_input: {} },
    { host: 'codex', env: {}, settings: {}, stateDir, now: NOW });
  for (const name of ['functions.write_stdin', 'functions.wait', 'collaboration.wait_agent', 'clock.sleep'])
    for (let i = 0; i < 6; i++) assert.equal(call(name), null, name);
  assert.equal(readdirSync(stateDir).length, 0);
  assert.equal(call('untrusted.write_stdin').verdict, 'ok');
});

test('guard state containing input fingerprints is stored privately', t => {
  const root = mkdtempSync(join(tmpdir(), 'guard-private-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  assert.equal(guardCall({ session_id: 'private', tool_name: 'Bash', tool_input: { command: 'read data' } },
    { env: {}, settings: {}, stateDir }).verdict, 'ok');
  const file = join(stateDir, readdirSync(stateDir)[0]);
  assert.ok(readFileSync(file, 'utf8').includes('entries'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('parallel hook processes preserve the complete read-modify-write transaction', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'guard-parallel-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const module = new URL('./loop-guard-hook.js', import.meta.url).href;
  const code = `import {guardCall} from ${JSON.stringify(module)}; guardCall({session_id:'s',tool_name:'Bash',tool_input:{command:'same'}},{env:{},settings:{},stateDir:process.argv[1]});`;
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', code, stateDir])));
  const files = readdirSync(stateDir);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(readFileSync(join(stateDir, files[0]), 'utf8')).entries.length, 8);
});
