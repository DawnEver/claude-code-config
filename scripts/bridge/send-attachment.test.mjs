import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { sendSessionAttachment } from './send-attachment.mjs';

test('Codex upload CLI uses authenticated session-scoped IPC and propagates failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upload-'));
  const adapter = new ClaudeAdapter();
  try {
    const port = await adapter.listen();
    const runtimeFile = path.join(dir, 'runtime.json');
    fs.writeFileSync(runtimeFile, JSON.stringify({ port, token: adapter.token }));
    const calls = [];
    adapter.sendCodexAttachment = async (id, request) => { calls.push({ id, request }); return { message_id: 42 }; };
    assert.equal((await sendSessionAttachment(path.join(dir, 'result.txt'), { runtimeFile, sessionId: 'thread' })).message_id, 42);
    assert.equal(calls[0].id, 'thread');
    assert.equal(calls[0].request.kind, 'document');
    adapter.sendCodexAttachment = async () => { throw new Error('no live confirmed attachment Topic'); };
    await assert.rejects(sendSessionAttachment(path.join(dir, 'result.txt'), { runtimeFile, sessionId: 'thread' }), /no live confirmed/);
  } finally { await adapter.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
