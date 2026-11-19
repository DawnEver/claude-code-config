import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { AgyAdapter, agyCallFor, agyPromptText, agyTurnTexts, forwardAgyHook, readAgyCwds, toolTaskId } from './agy-adapter.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));

function collect(a) {
  const ev = [];
  for (const k of ['up', 'down', 'status', 'prompt', 'progress', 'final']) a.on(k, (e) => ev.push([k, e]));
  return ev;
}

test('a turn: up on the first hook, prompt, tool task, final at Stop, idle', () => {
  let t = 1000;
  const a = new AgyAdapter({ now: () => t });
  const ev = collect(a);
  a.handle({ sessionId: 'c1', event: 'SessionStart', cwd: '/w', at: 1 });
  a.handle({ sessionId: 'c1', event: 'PreInvocation', invocationNum: 1, text: 'hello', at: 2 });
  assert.deepEqual(ev.filter(([k]) => k === 'up').map(([, e]) => e.cwd), ['/w']);
  assert.deepEqual(ev.filter(([k]) => k === 'prompt').map(([, e]) => e.text), ['hello']);
  const tc = { name: 'run_command', args: { CommandLine: 'npm test' } };
  a.handle({ sessionId: 'c1', event: 'PreToolUse', toolCall: tc, invocationNum: 1, at: 3 });
  assert.equal(a.statusSnapshot('c1').state, 'running');
  assert.equal(a.statusSnapshot('c1').tasks[0].label, 'npm test');
  a.handle({ sessionId: 'c1', event: 'PostToolUse', toolCall: tc, invocationNum: 1, at: 4 });
  assert.equal(a.statusSnapshot('c1').tasks, undefined);
  assert.ok(ev.some(([k]) => k === 'progress'));
  const r = a.handle({ sessionId: 'c1', event: 'Stop', texts: ['done'], at: 5 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(ev.filter(([k]) => k === 'final').map(([, e]) => e.text), ['done']);
  assert.equal(a.statusSnapshot('c1').state, 'idle');
  // A repeated Stop with the same blocks sends nothing new.
  a.handle({ sessionId: 'c1', event: 'Stop', texts: ['done'], at: 6 });
  assert.equal(ev.filter(([k]) => k === 'final').length, 1);
});

test('Telegram messages queue (on disk) and are delivered by the next Stop', async () => {
  const queueDir = tmp();
  const a = new AgyAdapter({ queueDir });
  a.handle({ sessionId: 'c2', event: 'PreInvocation', invocationNum: 1, text: 'x' });
  const q = await a.inject('c2', 'from phone', 'ann');
  assert.equal(q.queued, true);
  // A restart keeps it: a new adapter loads the queue when the session comes up.
  const b = new AgyAdapter({ queueDir });
  const r = b.handle({ sessionId: 'c2', event: 'Stop', texts: ['ok'] });
  assert.deepEqual(r.deliver, [{ text: 'from phone', user: 'ann', userId: '' }]);
  assert.equal(b.statusSnapshot('c2').state, 'running');
  assert.equal(b.handle({ sessionId: 'c2', event: 'Stop', texts: ['ok2'] }).deliver, undefined);
  // A continuation's PreInvocation is not a typed prompt.
  const ev = collect(b);
  b.handle({ sessionId: 'c2', event: 'PreInvocation', invocationNum: 1, text: 'Message from Telegram', continuationActive: true });
  assert.equal(ev.filter(([k]) => k === 'prompt').length, 0);
});

test('a silent session goes down; bad calls are refused', () => {
  let t = 0;
  const a = new AgyAdapter({ now: () => t, idleDownMs: 100, runningDownMs: 1000 });
  const ev = collect(a);
  a.handle({ sessionId: 'c3', event: 'SessionStart' });
  t = 50; a.sweep();
  assert.ok(!ev.some(([k]) => k === 'down'));
  t = 200; a.sweep();
  assert.deepEqual(ev.filter(([k]) => k === 'down').map(([, e]) => e.id), ['c3']);
  assert.equal(a.statusSnapshot('c3').state, 'disconnected');
  assert.throws(() => a.handle({ sessionId: '', event: 'Stop' }));
  assert.throws(() => a.handle({ sessionId: 'x', event: 'Nope' }));
});

test('the workspace of each conversation is noted for the usage store', () => {
  const cwdFile = path.join(tmp(), 'agy-cwd.json');
  const a = new AgyAdapter({ cwdFile });
  a.handle({ sessionId: 'c4', event: 'SessionStart', cwd: '/repo' });
  assert.deepEqual(readAgyCwds(cwdFile), { c4: '/repo' });
});

test('hook side: payload mapping, transcript texts, prompt envelope', () => {
  const dir = tmp();
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, [
    { type: 'USER_INPUT', content: 'q1' }, { type: 'PLANNER_RESPONSE', content: 'old' },
    { type: 'USER_INPUT', content: 'q2' }, { type: 'PLANNER_RESPONSE', content: '' }, { type: 'PLANNER_RESPONSE', content: 'a' }, { type: 'PLANNER_RESPONSE', content: 'b' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual(agyTurnTexts(file), ['a', 'b']);
  assert.equal(agyPromptText('<USER_REQUEST>\nhi there\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), 'hi there');
  const c = agyCallFor('Stop', { conversationId: 'c', workspacePaths: ['/w'], transcriptPath: file, terminationReason: 'done' });
  assert.equal(c.cwd, '/w');
  assert.deepEqual(c.texts, ['a', 'b']);
  const p = agyCallFor('PreToolUse', { conversationId: 'c', cwd: '/x', toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, invocationNum: 2 });
  assert.equal(p.cwd, '/x');
  assert.equal(p.toolCall.name, 'run_command');
  assert.equal(toolTaskId('c', 2, p.toolCall), toolTaskId('c', 2, { name: 'run_command', args: { CommandLine: 'ls' } }));
});

test('forwardAgyHook fails open, and turns a Stop delivery into stopContinue', async () => {
  const none = path.join(tmp(), 'runtime.json');
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: none }), {});
  const rt = path.join(tmp(), 'runtime.json');
  fs.writeFileSync(rt, '{}');
  const call = async () => ({ ok: true, deliver: [{ text: 'hi', user: 'ann' }] });
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: rt, call }), { stopContinue: 'Message from Telegram (ann):\nhi' });
  assert.deepEqual(await forwardAgyHook('PostToolUse', { conversationId: 'c' }, { runtimeFile: rt, call }), {});
  assert.deepEqual(await forwardAgyHook('Stop', { conversationId: 'c' }, { runtimeFile: rt, call: async () => { throw new Error('x'); } }), {});
});

test('end to end over the Claude IPC: the agy method reaches the adapter with the token', async () => {
  const claude = new ClaudeAdapter({ token: 't'.repeat(48) });
  const agy = new AgyAdapter();
  claude.local.agy = (p) => agy.handle(p);
  const port = await claude.listen(0);
  const rt = path.join(tmp(), 'runtime.json');
  fs.writeFileSync(rt, JSON.stringify({ port, token: claude.token }));
  const ups = [];
  agy.on('up', (e) => ups.push(e.id));
  try {
    assert.deepEqual(await forwardAgyHook('SessionStart', { conversationId: 'e2e', cwd: '/w' }, { runtimeFile: rt }), {});
    assert.deepEqual(ups, ['e2e']);
    await agy.inject('e2e', 'yo', 'bob');
    const r = await forwardAgyHook('Stop', { conversationId: 'e2e' }, { runtimeFile: rt });
    assert.equal(r.stopContinue, 'Message from Telegram (bob):\nyo');
    // A wrong token is refused (the call fails open to {}).
    fs.writeFileSync(rt, JSON.stringify({ port, token: 'x'.repeat(48) }));
    assert.deepEqual(await forwardAgyHook('SessionStart', { conversationId: 'other' }, { runtimeFile: rt }), {});
    assert.deepEqual(ups, ['e2e']);
  } finally { await claude.close(); }
});
void net;
