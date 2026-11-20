import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { resolveAttachmentSession, sendSessionAttachment } from './send-attachment.mjs';

test('resolveAttachmentSession detects codex, agy (ANTIGRAVITY_CONVERSATION_ID), and claude', () => {
  assert.deepEqual(resolveAttachmentSession({ CODEX_THREAD_ID: 'cx-1' }), { agent: 'codex', sessionId: 'cx-1' });
  assert.deepEqual(resolveAttachmentSession({ ANTIGRAVITY_CONVERSATION_ID: 'agy-1' }), { agent: 'agy', sessionId: 'agy-1' });
  assert.deepEqual(resolveAttachmentSession({ CLAUDE_CODE_SESSION_ID: 'cl-1' }), { agent: 'claude', sessionId: 'cl-1' });
  assert.deepEqual(resolveAttachmentSession({}), { agent: 'codex', sessionId: null });
});

test('sendSessionAttachment delivers an agy session attachment over local IPC using ANTIGRAVITY_CONVERSATION_ID', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-att-'));
  const hub = new ClaudeAdapter();
  const received = [];
  hub.sendAttachment = async (agent, sessionId, params) => {
    received.push({ agent, sessionId, path: params.path, kind: params.kind, caption: params.caption });
    return { ok: true };
  };
  const port = await hub.listen(0);
  t.after(async () => { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const runtimeFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ port, token: hub.token }));
  const sample = path.join(dir, 'report.pdf');
  fs.writeFileSync(sample, 'pdf');

  await sendSessionAttachment(sample, {
    kind: 'document',
    caption: 'Plot',
    env: { ANTIGRAVITY_CONVERSATION_ID: 'conv-agy-99' },
    runtimeFile,
  });
  assert.deepEqual(received, [{
    agent: 'agy',
    sessionId: 'conv-agy-99',
    path: path.resolve(sample),
    kind: 'document',
    caption: 'Plot',
  }]);
});
