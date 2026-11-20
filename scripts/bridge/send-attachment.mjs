#!/usr/bin/env node
// Send a local file to a session's Topic through the bridge's local IPC (the runtime token
// authenticates). Codex (`CODEX_THREAD_ID`), Antigravity (`ANTIGRAVITY_CONVERSATION_ID`), and
// Claude (`CLAUDE_CODE_SESSION_ID`) sessions all resolve their active session from the environment.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { RUNTIME_FILE } from './runtime-paths.mjs';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';
import { isMain } from '../shared/is-main.mjs';

/** Resolve `{ agent, sessionId }` from environment variables when not passed explicitly. */
export function resolveAttachmentSession(env = process.env) {
  if (env.CODEX_THREAD_ID) return { agent: 'codex', sessionId: env.CODEX_THREAD_ID };
  if (env.ANTIGRAVITY_CONVERSATION_ID) return { agent: 'agy', sessionId: env.ANTIGRAVITY_CONVERSATION_ID };
  if (env.CLAUDE_CODE_SESSION_ID) return { agent: 'claude', sessionId: env.CLAUDE_CODE_SESSION_ID };
  return { agent: 'codex', sessionId: null };
}

export async function sendSessionAttachment(file, {
  kind = 'document',
  caption,
  agent,
  sessionId,
  env = process.env,
  runtimeFile = RUNTIME_FILE,
} = {}) {
  const detected = resolveAttachmentSession(env);
  const resolvedAgent = agent ?? detected.agent;
  const resolvedId = sessionId ?? detected.sessionId;
  if (!resolvedId) {
    throw new Error('CODEX_THREAD_ID, ANTIGRAVITY_CONVERSATION_ID, CLAUDE_CODE_SESSION_ID, or explicit sessionId required');
  }
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const socket = net.connect({ host: '127.0.0.1', port: runtime.port });
  const peer = new JsonRpcPeer(t => socket.write(t + '\n'), { timeoutMs: 120000 });
  socket.on('data', lineSplitter(l => peer.receive(l)));
  socket.on('close', () => peer.failAll('connection closed; delivery may be uncertain'));
  socket.on('error', () => peer.failAll('bridge connection failed'));
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    return await peer.request('attachment', { token: runtime.token, agent: resolvedAgent, sessionId: resolvedId,
      path: path.resolve(file), kind, caption });
  } finally { socket.destroy(); }
}

if (isMain(import.meta.url)) {
  const [file, kind = 'document'] = process.argv.slice(2);
  if (!file) { console.error('Usage: node scripts/bridge/send-attachment.mjs <file> [photo|document]'); process.exitCode = 1; }
  else sendSessionAttachment(file, { kind }).then(() => console.log('sent'), e => {
    console.error(e.message); process.exitCode = 1;
  });
}
