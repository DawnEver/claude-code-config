import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { agyTranscript } from './transcripts.mjs';
import { UsageScanner, PARSERS } from './scan.mjs';

const line = (e) => JSON.stringify(e);
const TRANSCRIPT = [
  { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-19T10:00:00Z', content: '<USER_REQUEST>hi</USER_REQUEST>' },
  { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:00:05Z', model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10,
    tool_calls: [{ name: 'run_command', args: {} }, { name: 'read_file', args: {} }] },
  { step_index: 2, type: 'GENERIC', created_at: '2026-11-19T10:00:09Z', content: 'tool output' },
  { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:00:12Z', model: 'gemini-4-neon-high', input_tokens: 20, cache_read_tokens: 100, output_tokens: 5, content: 'done' },
  { step_index: 4, type: 'SYSTEM_MESSAGE', created_at: '2026-11-19T10:05:00Z', content: 'a subagent reports' },
  { step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:05:03Z', model: 'claude-opus-5-5-low', input_tokens: 7, cache_read_tokens: 120, output_tokens: 3 },
].map(line).join('\n') + '\n';

test('agyTranscript: one turn per USER_INPUT / SYSTEM_MESSAGE, one call per PLANNER_RESPONSE', () => {
  const t = agyTranscript(TRANSCRIPT, { session: 'conv' });
  assert.equal(t.session, 'conv');
  assert.equal(t.turns.length, 2);
  const [a, b] = t.turns;
  assert.deepEqual({ turn: a.turn, origin: a.origin, client: a.client, model: a.model, calls: a.calls, input: a.input, cache_read: a.cache_read, output: a.output },
    { turn: 'conv:0', origin: 'human', client: 'agy', model: 'gemini-4-neon-high', calls: 2, input: 120, cache_read: 100, output: 15 });
  assert.deepEqual(JSON.parse(a.tools), { run_command: 1, read_file: 1 });
  assert.equal(a.ended_at - a.started_at, 12000);
  assert.deepEqual({ origin: b.origin, model: b.model, calls: b.calls }, { origin: 'system', model: 'claude-opus-5-5-low', calls: 1 });
});

test('the scanner reads each conversation transcript.jsonl (not transcript_full), session = brain dir, project from the noted workspace', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyu-'));
  const logs = path.join(home, 'brain', 'conv-1', '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), TRANSCRIPT);
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), TRANSCRIPT);
  assert.equal(PARSERS.agy(TRANSCRIPT, path.join(logs, 'transcript.jsonl')).session, 'conv-1');
  const src = { agent: 'agy', root: path.join(home, 'brain'), depth: 3, only: 'transcript.jsonl', seat: null, account: () => 'agy:a@x.io', cwdOf: (s) => (s === 'conv-1' ? '/repo' : null) };
  const sc = new UsageScanner({ cursorFile: path.join(home, 'cursor.json'), sources: () => [src], project: (cwd) => `p:${cwd}` });
  const r = await sc.collect();
  assert.equal(r.turns.length, 2);
  assert.ok(r.turns.every((t) => t.agent === 'agy' && t.session === 'conv-1' && t.account === 'agy:a@x.io' && t.project === 'p:/repo'));
});
