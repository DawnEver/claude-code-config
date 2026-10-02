#!/usr/bin/env node
// Explicit Codex attachment publication through the existing session bridge IPC.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { RUNTIME_FILE } from './context.mjs';
import { JsonRpcPeer, lineSplitter } from './jsonrpc.mjs';
import { isMain } from '../shared/is-main.mjs';

export async function sendSessionAttachment(file, { kind = 'document', caption,
  sessionId = process.env.CODEX_THREAD_ID, runtimeFile = RUNTIME_FILE } = {}) {
  if (!sessionId) throw new Error('CODEX_THREAD_ID or explicit sessionId required');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const socket = net.connect({ host: '127.0.0.1', port: runtime.port });
  const peer = new JsonRpcPeer(t => socket.write(t + '\n'), { timeoutMs: 120000 });
  socket.on('data', lineSplitter(l => peer.receive(l)));
  socket.on('close', () => peer.failAll('connection closed; delivery may be uncertain'));
  socket.on('error', () => peer.failAll('bridge connection failed'));
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    return await peer.request('codex_attachment', { token: runtime.token, sessionId,
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
