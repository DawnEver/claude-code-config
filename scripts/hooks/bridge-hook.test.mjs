import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { finalAssistantText, mirrorFor, sendMirror } from './bridge-hook.js';
import { ClaudeAdapter } from '../bridge/claude-adapter.mjs';

const j = (o) => JSON.stringify(o);
const user = (content) => j({ type: 'user', message: { role: 'user', content } });
const asst = (content) => j({ type: 'assistant', message: { role: 'assistant', content } });

test('finalAssistantText: text blocks after the last real user message only', () => {
  const lines = [
    user('old question'),
    asst([{ type: 'text', text: 'old answer' }]),
    user('new question'),
    asst([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't', content: 'file' }]),
    asst([{ type: 'text', text: 'Done.' }]),
    j({ type: 'system', subtype: 'x' }),
  ].join('\n');
  assert.equal(finalAssistantText(lines), 'Let me look.\n\nDone.');
  assert.equal(finalAssistantText(user('q')), '');
  assert.equal(finalAssistantText('garbage\n' + user([{ type: 'text', text: 'q' }]) + '\n' + asst([{ type: 'text', text: 'a' }])), 'a');
});

test('mirrorFor: prompt from payload, channel injections skipped, final prefers last_assistant_message', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'boot' };
  assert.deepEqual(mirrorFor({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' }, env),
    { sessionIds: ['s', 'boot'], kind: 'prompt', text: 'hi' });
  assert.equal(mirrorFor({ hook_event_name: 'UserPromptSubmit', prompt: '<channel source="session-bridge">x</channel>' }, env).text, '<channel source="session-bridge">x</channel>', 'passed through; the adapter unwraps it');
  assert.equal(mirrorFor({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, {}), null, 'no session id -> no-op');
  assert.deepEqual(mirrorFor({ hook_event_name: 'UserPromptSubmit', session_id: 'boot', prompt: 'hi' }, env).sessionIds, ['boot'], 'deduplicated');
  assert.deepEqual(mirrorFor({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'bye' }, env),
    { sessionIds: ['s', 'boot'], kind: 'final', text: 'bye' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  try {
    const tp = path.join(dir, 't.jsonl');
    fs.writeFileSync(tp, [user('q'), asst([{ type: 'text', text: 'from transcript' }])].join('\n'));
    assert.equal(mirrorFor({ hook_event_name: 'Stop', transcript_path: tp }, env).text, 'from transcript');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(mirrorFor({ hook_event_name: 'Stop', transcript_path: '/nope' }, env), null);
});

test('sendMirror delivers to a live hub, and resolves quietly when none runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  const hub = new ClaudeAdapter();
  try {
    const port = await hub.listen(0);
    const runtimeFile = path.join(dir, 'runtime.json');
    fs.writeFileSync(runtimeFile, j({ port, token: hub.token }));
    assert.equal(await sendMirror({ sessionIds: ['s'], kind: 'final', text: 'ok' }, { runtimeFile }), true);
    assert.deepEqual(hub.held.map((h) => h.m), [{ sessionIds: ['s'], kind: 'final', text: 'ok' }], 'held until its session registers');
    assert.equal(await sendMirror({ sessionIds: ['s'], kind: 'final', text: 'x' }, { runtimeFile: path.join(dir, 'none.json') }), false);
  } finally { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
