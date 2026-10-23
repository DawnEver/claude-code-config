import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexLocalObserver } from './codex-local.mjs';

const at = 1800000000000;
const row = (type, payload, time = at) => JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n';
function fixture({ source = 'cli', parent_thread_id, time = at } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-'));
  const dir = path.join(root, '2027', '01', '15');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, row('session_meta', { id: 'local', cwd: '/work', source, parent_thread_id, git: { branch: 'main' } }, time));
  const observer = new CodexLocalObserver({ root, sources: ['cli', 'vscode'], now: () => at });
  const events = [];
  for (const kind of ['up', 'down', 'prompt', 'message', 'final', 'notice', 'status']) observer.on(kind, (e) => events.push({ kind, ...e }));
  return { root, file, observer, events, append: (s) => fs.appendFileSync(file, s) };
}

test('recent standalone activity becomes explicitly observation-only, without replaying old text', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.append(row('event_msg', { type: 'user_message', message: 'old prompt' }, at - 1000));
  await f.observer.refresh();
  assert.equal(f.observer.has('local'), true);
  assert.equal(f.events.filter(e => e.kind === 'up').length, 1);
  assert.match(f.events.find(e => e.kind === 'notice').text, /Observation only/);
  assert.equal(f.events.some(e => e.kind === 'prompt'), false);
  assert.equal(f.observer.statusSnapshot('local').observationOnly, true);
});

test('new legacy and paginated messages mirror once; partial UTF-8 lines wait for completion', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await f.observer.refresh();
  f.append(row('event_msg', { type: 'task_started', turn_id: 'T' }));
  f.append(row('event_msg', { type: 'item_completed', turn_id: 'T', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'hello' }] } }));
  f.append(row('event_msg', { type: 'item_completed', turn_id: 'T', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: '你好' }], phase: 'commentary' } }));
  f.append(row('event_msg', { type: 'agent_message', message: '你好' }));
  const next = Buffer.from(row('response_item', { type: 'message', id: 'b', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'world' }] }));
  f.append(next.subarray(0, next.length - 2));
  await f.observer.refresh();
  assert.deepEqual(f.events.filter(e => e.kind === 'prompt').map(e => e.text), ['hello']);
  assert.deepEqual(f.events.filter(e => e.kind === 'message').map(e => e.text), ['你好']);
  assert.deepEqual(f.events.filter(e => e.kind === 'final').map(e => e.text), []);
  f.append(next.subarray(next.length - 2));
  await f.observer.refresh();
  await f.observer.refresh();
  assert.deepEqual(f.events.filter(e => e.kind === 'final').map(e => e.text), ['world']);
});

test('loaded shared threads and subagents never register or mirror', async (t) => {
  for (const options of [{}, { parent_thread_id: 'parent' }, { source: { subagent: {} } }]) {
    const f = fixture(options); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    f.append(row('event_msg', { type: 'user_message', message: 'skip' }));
    await f.observer.refresh(options.source || options.parent_thread_id ? new Set() : new Set(['local']));
    assert.deepEqual(f.events, []);
  }
});

test('historical files do not create topics; idle observations retire and activity restores them', async (t) => {
  let clock = at;
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.observer.now = () => clock;
  f.append(row('event_msg', { type: 'user_message', message: 'history' }, at - 3600000));
  await f.observer.refresh();
  assert.equal(f.events.length, 0);
  f.append(row('event_msg', { type: 'user_message', message: 'new' }));
  await f.observer.refresh();
  assert.equal(f.observer.has('local'), true);
  clock += 11 * 60000;
  await f.observer.refresh();
  assert.equal(f.observer.has('local'), false);
  assert.equal(f.events.filter(e => e.kind === 'down').length, 1);
  f.append(row('event_msg', { type: 'user_message', message: 'back' }, clock));
  await f.observer.refresh();
  assert.equal(f.observer.has('local'), true);
});

test('shared takeover is silent and consumes skipped bytes instead of replaying them later', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.append(row('event_msg', { type: 'user_message', message: 'first' }));
  await f.observer.refresh();
  f.events.length = 0;
  f.append(row('event_msg', { type: 'user_message', message: 'shared' }));
  await f.observer.refresh(new Set(['local']));
  assert.equal(f.observer.has('local'), false);
  assert.equal(f.events.length, 0);
  await f.observer.refresh();
  assert.equal(f.events.some(e => e.text === 'shared'), false);
});

test('partial multibyte text is decoded only after its complete JSON line arrives', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await f.observer.refresh();
  const bytes = Buffer.from(row('event_msg', { type: 'user_message', message: '你好' }));
  const split = bytes.indexOf(Buffer.from('你')) + 1;
  f.append(bytes.subarray(0, split));
  await f.observer.refresh();
  assert.equal(f.events.length, 0);
  f.append(bytes.subarray(split));
  await f.observer.refresh();
  assert.deepEqual(f.events.filter(e => e.kind === 'prompt').map(e => e.text), ['你好']);
});

test('reasoning, tool output and user-role context records never leave the observer', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await f.observer.refresh();
  f.append(row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'secret instructions' }] }));
  f.append(row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected context' }] }));
  f.append(row('event_msg', { type: 'item_completed', item: { type: 'Reasoning', raw_content: ['private reasoning'] } }));
  f.append(row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', aggregated_output: 'secret output' } }));
  await f.observer.refresh();
  assert.equal(f.events.some(e => ['prompt', 'message', 'final'].includes(e.kind)), false);
  assert.match(f.observer.controlError('local').message, /stop that TUI first/);
});
