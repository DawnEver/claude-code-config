// LAB_SESSION is the vendor's conversation id, stable across a resume; an inherited id still wins.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeProjectSlug, claudeSession, codexSession } from './vendor-session.mjs';
import { withClaudeSession } from '../runtime/cc-launcher.mjs';
import { buildCodexInvocation } from '../runtime/codex-launcher.mjs';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function claudeDir(cwd, ids) {
  const configDir = mkdtempSync(join(tmpdir(), 'vs-claude-'));
  const dir = join(configDir, 'projects', claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  ids.forEach((id, i) => {
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, '{}\n');
    utimesSync(file, 1000 + i, 1000 + i);
  });
  return configDir;
}

const launch = (env, args, seams) => {
  const out = withClaudeSession(env, args, seams);
  return { id: env.LAB_SESSION, args: out.extraArgs };
};

test('fresh Claude session: a new id, pinned as Claude\'s own with --session-id', () => {
  const seams = { configDir: claudeDir('/w', []), cwd: '/w' };
  const one = launch({}, [], seams);
  const two = launch({}, [], seams);
  assert.notEqual(one.id, two.id);
  assert.deepEqual(one.args, ['--session-id', one.id]);
});

test('resumed Claude session keeps the id it was pinned to (planted control: a fresh launch gets another)', () => {
  const seams = { configDir: claudeDir('/w', []), cwd: '/w' };
  const first = launch({}, [], seams);
  const resumed = launch({}, ['--resume', first.id], seams);
  assert.equal(resumed.id, first.id);
  assert.deepEqual(resumed.args, ['--resume', first.id], 'a resume is never re-pinned');
  assert.equal(launch({}, ['--resume', A, '--fork-session'], seams).id, A, 'a fork carries the original');
  assert.notEqual(launch({}, [], seams).id, first.id);
});

test('--continue takes the cwd\'s newest transcript id (planted control: another cwd has none)', () => {
  const configDir = claudeDir('C:\\work\\repo', [A, B]);
  assert.equal(claudeSession(['--continue'], { configDir, cwd: 'C:\\work\\repo' }).id, B);
  assert.equal(launch({}, ['-c'], { configDir, cwd: 'C:\\work\\repo' }).id, B);
  assert.equal(claudeSession(['-c'], { configDir, cwd: 'C:\\elsewhere' }).id, null);
});

test('a child inherits its parent\'s id and is never pinned (planted control: without it, it is pinned)', () => {
  const seams = { configDir: claudeDir('/w', [A]), cwd: '/w' };
  assert.deepEqual(launch({ LAB_SESSION: 'outer-session-1' }, ['--resume', A], seams), { id: 'outer-session-1', args: ['--resume', A] });
  assert.deepEqual(launch({ LAB_SESSION: 'outer-session-1' }, [], seams), { id: 'outer-session-1', args: [] });
  assert.equal(launch({}, [], seams).args[0], '--session-id');
});

test('a claude command (no conversation) and the resume picker are never pinned', () => {
  const seams = { configDir: claudeDir('/w', []), cwd: '/w' };
  assert.deepEqual(launch({}, ['mcp', 'list'], seams).args, ['mcp', 'list']);
  const picker = launch({}, ['--resume'], seams);
  assert.deepEqual(picker.args, ['--resume']);
  assert.ok(picker.id, 'the picker falls back to a launcher id');
});

test('codex: resume <id> and resume --last keep the thread id; a fresh launch falls back; a child inherits', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'vs-codex-'));
  const day = join(codexHome, 'sessions', '2026', '10', '21');
  mkdirSync(day, { recursive: true });
  for (const [i, id] of [A, B].entries()) {
    const file = join(day, `rollout-2026-10-21T10-0${i}-00-${id}.jsonl`);
    writeFileSync(file, '{}\n');
    utimesSync(file, 1000 + i, 1000 + i);
  }
  assert.equal(codexSession(['resume', A], { codexHome }), A);
  assert.equal(codexSession(['resume', '--last'], { codexHome }), B);
  assert.equal(codexSession([], { codexHome }), null);
  const run = (baseEnv, extraArgs) => buildCodexInvocation({ provider: null, envSettingsPath: '/nonexistent', extraArgs, baseEnv, codexHome }).env.LAB_SESSION;
  assert.equal(run({}, ['resume', A]), A);
  assert.equal(run({ LAB_SESSION: 'outer-session-1' }, ['resume', A]), 'outer-session-1');
  assert.ok(run({}, []));
  assert.notEqual(run({}, []), A);
});
