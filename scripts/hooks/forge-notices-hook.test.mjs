import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { respond } from './forge-notices-hook.js';
import { CACHE_MS, HEADER, forgeNotices } from '../shared/forge-notices.mjs';

const LINE = '243-abcdef123456-red: #243 pr/x at abcdef123456 red -- tests/base failure [s1]';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'notices-'));
  const bin = process.platform === 'win32' ? join(root, '.venv', 'Scripts') : join(root, '.venv', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  mkdirSync(join(root, 'sub'));
  return { root, cacheDir: join(root, 'cache') };
}

function counting(lines) {
  const calls = [];
  return { calls, run: (_found, session) => { calls.push(session); return lines; } };
}

test('SessionStart injects the open notices as additional context', () => {
  const { root, cacheDir } = repo();
  const { run } = counting([LINE]);
  const out = respond({ hook_event_name: 'SessionStart', cwd: join(root, 'sub') }, { env: { LAB_SESSION: 's1' }, run, cacheDir });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(HEADER));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(LINE));
});

test('silent without LAB_SESSION, without notices, or when the forge read fails (planted control: with them it speaks)', () => {
  const { root, cacheDir } = repo();
  const input = { hook_event_name: 'SessionStart', cwd: root };
  assert.equal(respond(input, { env: {}, run: counting([LINE]).run, cacheDir }), null);
  assert.equal(respond(input, { env: { LAB_SESSION: 's1' }, run: counting([]).run, cacheDir }), null);
  assert.equal(respond(input, { env: { LAB_SESSION: 's2' }, run: () => null, cacheDir }), null);
  assert.ok(respond(input, { env: { LAB_SESSION: 's3' }, run: counting([LINE]).run, cacheDir }));
});

test('silent outside a repo with a venv', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'novenv-'));
  assert.equal(respond({ hook_event_name: 'SessionStart', cwd }, { env: { LAB_SESSION: 's1' }, run: counting([LINE]).run }), null);
});

test('Stop surfaces a notice once, and never inside a stop the hook already continued', () => {
  const { root, cacheDir } = repo();
  const { run } = counting([LINE]);
  const seams = { env: { LAB_SESSION: 's1' }, run, cacheDir };
  const first = respond({ hook_event_name: 'Stop', cwd: root }, seams);
  assert.equal(first.decision, 'block');
  assert.ok(first.reason.includes(LINE));
  assert.equal(respond({ hook_event_name: 'Stop', cwd: root }, seams), null, 'told once');
  assert.equal(respond({ hook_event_name: 'Stop', cwd: root, stop_hook_active: true }, { ...seams, env: { LAB_SESSION: 's9' } }), null);
});

test('the forge is asked at most once per cache window', () => {
  const { root, cacheDir } = repo();
  const { calls, run } = counting([LINE]);
  forgeNotices({ session: 's1', cwd: root, now: 1_000, run, cacheDir });
  forgeNotices({ session: 's1', cwd: root, now: 1_000 + CACHE_MS - 1, run, cacheDir });
  assert.equal(calls.length, 1);
  forgeNotices({ session: 's1', cwd: root, now: 1_000 + CACHE_MS + 1, run, cacheDir });
  assert.equal(calls.length, 2);
});
