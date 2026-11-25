import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { agyTranscript } from './transcripts.mjs';
import { UsageScanner, PARSERS, sources } from './scan.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const line = (e) => JSON.stringify(e);
const SUB_ID = '11111111-2222-3333-4444-555555555555';
const PARENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TRANSCRIPT = [
  { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-19T10:00:00Z', content: '<USER_REQUEST>hi</USER_REQUEST>' },
  { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:00:05Z', model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10,
    tool_calls: [{ name: 'run_command', args: {} }, { name: 'invoke_subagent', args: {} }] },
  { step_index: 2, type: 'GENERIC', created_at: '2026-11-19T10:00:09Z',
    content: `Created the following subagent:\n{\n  "conversationId": "${SUB_ID}",\n  "workspaceUris": [\n    "file:///repo/consumer-a"\n  ]\n}` },
  { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:00:12Z', model: 'gemini-4-neon-high', input_tokens: 20, cache_read_tokens: 100, output_tokens: 5, content: 'done' },
  { step_index: 4, type: 'SYSTEM_MESSAGE', created_at: '2026-11-19T10:05:00Z', content: 'a subagent reports' },
  { step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:05:03Z', model: 'claude-opus-5-5-low', input_tokens: 7, cache_read_tokens: 120, output_tokens: 3 },
].map(line).join('\n') + '\n';

const SUB_TRANSCRIPT = [
  { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-19T10:00:10Z', content: 'subagent task' },
  { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-19T10:00:15Z', model: 'gemini-4-carbon-low', input_tokens: 50, cache_read_tokens: 0, output_tokens: 8 },
].map(line).join('\n') + '\n';

test('agyTranscript: one turn per USER_INPUT / SYSTEM_MESSAGE, subagent flag sets origin=subagent, extracts subagent workspaceUris', () => {
  const t = agyTranscript(TRANSCRIPT, { session: 'conv' });
  assert.equal(t.session, 'conv');
  assert.equal(t.subagents[SUB_ID], 'file:///repo/consumer-a');
  assert.equal(t.turns.length, 2);
  const [a, b] = t.turns;
  assert.deepEqual({ turn: a.turn, origin: a.origin, client: a.client, model: a.model, calls: a.calls, input: a.input, cache_read: a.cache_read, output: a.output },
    { turn: 'conv:0', origin: 'human', client: 'agy', model: 'gemini-4-neon-high', calls: 2, input: 120, cache_read: 100, output: 15 });
  assert.deepEqual(JSON.parse(a.tools), { run_command: 1, invoke_subagent: 1 });
  assert.deepEqual({ origin: b.origin, model: b.model, calls: b.calls }, { origin: 'system', model: 'claude-opus-5-5-low', calls: 1 });

  const sub = agyTranscript(SUB_TRANSCRIPT, { session: SUB_ID, subagent: true });
  assert.equal(sub.turns[0].origin, 'subagent');
});

test('scanner attributes both main and subagent agy conversations to their workspace project via conversation_metadata.json and parent invoke_subagent', async t => {
  const root = tempDir('agyu-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agyDir = path.join(root, '.gemini', 'antigravity-cli');
  const repoDir = path.join(root, 'consumer-a');
  fs.mkdirSync(repoDir, { recursive: true });
  const repoUri = pathToFileURL(repoDir).href;

  fs.mkdirSync(path.join(agyDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(agyDir, 'cache', 'conversation_metadata.json'), JSON.stringify({
    conversations: {
      [PARENT_ID]: { is_internal: false, summary: { WorkspaceURIs: [repoUri] } },
      [SUB_ID]: { is_internal: true },
    },
  }));
  const parentLogs = path.join(agyDir, 'brain', PARENT_ID, '.system_generated', 'logs');
  const subLogs = path.join(agyDir, 'brain', SUB_ID, '.system_generated', 'logs');
  fs.mkdirSync(parentLogs, { recursive: true });
  fs.mkdirSync(subLogs, { recursive: true });
  const parentText = TRANSCRIPT.replace('file:///repo/consumer-a', repoUri);
  fs.writeFileSync(path.join(parentLogs, 'transcript.jsonl'), parentText);
  fs.writeFileSync(path.join(parentLogs, 'transcript_full.jsonl'), parentText);
  fs.writeFileSync(path.join(subLogs, 'transcript.jsonl'), SUB_TRANSCRIPT);

  const agySrc = sources(root, { machine: 'm', codexHomes: [], agyDir }).find((s) => s.agent === 'agy');
  const sc = new UsageScanner({ cursorFile: path.join(root, 'cursor.json'), sources: () => [agySrc], project: (cwd) => `proj:${path.basename(cwd)}` });
  const r = await sc.collect();
  const parentTurns = r.turns.filter((x) => x.session === PARENT_ID);
  const subTurns = r.turns.filter((x) => x.session === SUB_ID);
  assert.equal(parentTurns.length, 2);
  assert.equal(subTurns.length, 1);
  assert.equal(parentTurns[0].origin, 'human');
  assert.equal(parentTurns[0].project, 'proj:consumer-a');
  assert.equal(subTurns[0].origin, 'subagent');
  assert.equal(subTurns[0].project, 'proj:consumer-a');
});
