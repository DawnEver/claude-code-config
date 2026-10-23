import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIdentity } from './session-identity.mjs';

test('native root lineage and execution thread remain distinct, ahead of launcher fallback', () => {
  assert.deepEqual(sessionIdentity({ CODEX_SESSION_ID: 'root', CODEX_THREAD_ID: 'child', LAB_SESSION: 'old' }),
    { host: 'codex', sessionId: 'root', threadId: 'child' });
});

test('Codex hooks never use an ambiguous parent session_id as execution identity', () => {
  assert.deepEqual(sessionIdentity({}, { session_id: 'parent' }, { host: 'codex' }),
    { host: 'codex', sessionId: 'parent', threadId: null });
  assert.equal(sessionIdentity({}, { session_id: 'parent', agent_id: 'worker' }, { host: 'codex' }).threadId, 'worker');
});

test('native hook rollout identity is available without shell env and beats stale daemon inheritance', () => {
  const thread = '11111111-2222-4333-8444-555555555555';
  const payload = { session_id: 'native-root', transcript_path: `/sessions/rollout-2026-10-23T15-00-00-${thread}.jsonl` };
  assert.deepEqual(sessionIdentity({}, payload, { host: 'codex' }), { host: 'codex', sessionId: 'native-root', threadId: thread });
  assert.deepEqual(sessionIdentity({ CODEX_SESSION_ID: 'old-root', CODEX_THREAD_ID: 'old-thread' }, payload, { host: 'codex' }),
    { host: 'codex', sessionId: 'native-root', threadId: thread });
  assert.equal(sessionIdentity({}, { session_id: 'root', transcript_path: '/sessions/arbitrary.jsonl' }, { host: 'codex' }).threadId, null);
});

test('Claude retains its conversation identity; absent runtime identity stays absent', () => {
  assert.deepEqual(sessionIdentity({}, { session_id: 'claude-session' }),
    { host: 'claude', sessionId: 'claude-session', threadId: 'claude-session' });
  assert.deepEqual(sessionIdentity({}, {}, { host: 'codex' }),
    { host: 'codex', sessionId: null, threadId: null });
});
