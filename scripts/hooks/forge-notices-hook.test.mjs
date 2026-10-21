import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { respond } from './forge-notices-hook.js';
import { HEADER } from '../shared/forge-notices.mjs';

const LINE = '243-abcdef123456-red: #243 pr/x at abcdef123456 red -- tests/base failure [s1]';
const HOOK = 'forge-notices-hook.js';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'notices-'));
  const bin = process.platform === 'win32' ? join(root, '.venv', 'Scripts') : join(root, '.venv', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  mkdirSync(join(root, 'sub'));
  return root;
}

function counting(lines) {
  const calls = [];
  return { calls, run: (_found, session) => { calls.push(session); return lines; } };
}

test('SessionStart injects the open notices as additional context', () => {
  const root = repo();
  const out = respond({ hook_event_name: 'SessionStart', cwd: join(root, 'sub') }, { env: { LAB_SESSION: 's1' }, run: counting([LINE]).run });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(HEADER));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(LINE));
});

test('silent without LAB_SESSION, without notices, or when the forge read fails (planted control: with them it speaks)', () => {
  const root = repo();
  const input = { hook_event_name: 'SessionStart', cwd: root };
  assert.equal(respond(input, { env: {}, run: counting([LINE]).run }), null);
  assert.equal(respond(input, { env: { LAB_SESSION: 's1' }, run: counting([]).run }), null);
  assert.equal(respond(input, { env: { LAB_SESSION: 's2' }, run: () => null }), null);
  assert.ok(respond(input, { env: { LAB_SESSION: 's3' }, run: counting([LINE]).run }));
});

test('silent outside a repo with a venv', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'novenv-'));
  assert.equal(respond({ hook_event_name: 'SessionStart', cwd }, { env: { LAB_SESSION: 's1' }, run: counting([LINE]).run }), null);
});

test('no per-turn poll: any event but SessionStart never asks the forge (planted control: SessionStart does)', () => {
  const root = repo();
  const { calls, run } = counting([LINE]);
  for (const event of ['Stop', 'UserPromptSubmit', 'PostToolUse']) {
    assert.equal(respond({ hook_event_name: event, cwd: root }, { env: { LAB_SESSION: 's1' }, run }), null, event);
  }
  assert.equal(calls.length, 0);
  respond({ hook_event_name: 'SessionStart', cwd: root }, { env: { LAB_SESSION: 's1' }, run });
  assert.equal(calls.length, 1);
});

test('the settings template registers the hook under SessionStart and nowhere else', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const hooks = JSON.parse(readFileSync(join(here, '..', '..', 'claude_settings.template.json'), 'utf8')).hooks;
  const events = Object.entries(hooks)
    .filter(([, groups]) => groups.some((g) => g.hooks.some((h) => String(h.command).includes(HOOK))))
    .map(([event]) => event);
  assert.deepEqual(events, ['SessionStart']);
});
