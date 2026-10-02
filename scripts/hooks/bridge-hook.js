#!/usr/bin/env node
// bridge-hook.js — mirror a Claude session's prompts and final answers to its Telegram Topic.
//
// Wired for UserPromptSubmit and Stop. The model is not trusted to call the channel's
// `reply` tool, so — like the Codex adapter does for Codex — the transcript side is
// mirrored mechanically: one authenticated one-shot `mirror` call to the bridge daemon's
// Claude adapter (claude-adapter.mjs; 127.0.0.1, port + token from runtime.json), naming
// the session by id so the adapter can find the session's registered channel.
//
// Fail-open and silent: hook stdout can inject context, so nothing is ever printed; every
// failure exits 0; a hard 2 s timer bounds the whole run. A no-op unless the daemon's
// runtime file exists.

import fs from 'fs';
import net from 'net';
import { isMain } from '../shared/is-main.mjs';
import { RUNTIME_FILE } from '../bridge/context.mjs';
import { nearestClaude } from '../shared/process-tree.mjs';

const TIMEOUT_MS = 2000;

const isRealUser = (e) => {
  if (e?.type !== 'user' || e.isMeta) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b?.type === 'text');
};

/** Concatenated assistant text blocks after the last real user message of a JSONL transcript. */
export function finalAssistantText(jsonl) {
  const entries = [];
  for (const l of String(jsonl).split('\n')) {
    if (!l.trim()) continue;
    try { entries.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isRealUser(entries[i])) { start = i + 1; break; }
  const texts = [];
  for (const e of entries.slice(start)) {
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) if (b?.type === 'text' && b.text?.trim()) texts.push(b.text.trim());
  }
  return texts.join('\n\n');
}

/** The mirror call for one hook payload, or null when there is nothing to send. */
export function mirrorFor(payload, env = process.env) {
  // The current id, and the one this claude process started with (its channel's id).
  const sessionIds = [...new Set([payload?.session_id, env.CLAUDE_CODE_SESSION_ID].filter(Boolean))];
  if (!sessionIds.length) return null;
  const base = { sessionIds };
  if (payload?.hook_event_name === 'UserPromptSubmit') {
    const text = String(payload.prompt ?? '');
    // A channel prompt (from Telegram) is sent too: the daemon's echo suppression drops it.
    if (!text.trim()) return null;
    return { ...base, kind: 'prompt', text };
  }
  if (payload?.hook_event_name === 'Stop') {
    let text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
    if (!text.trim() && payload.transcript_path) {
      try { text = finalAssistantText(fs.readFileSync(payload.transcript_path, 'utf8')); } catch { return null; }
    }
    return text.trim() ? { ...base, kind: 'final', text } : null;
  }
  return null;
}

/** One authenticated `mirror` call to the hub. Resolves its result ({ok, routed}), or null. */
export function sendMirror(params, { runtimeFile = RUNTIME_FILE, timeoutMs = TIMEOUT_MS } = {}) {
  let rt;
  try { rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { return Promise.resolve(null); }
  if (!Number.isInteger(rt?.port) || typeof rt.token !== 'string') return Promise.resolve(null);
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: rt.port });
    const done = (v) => { clearTimeout(timer); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mirror', params: { token: rt.token, ...params } }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      try { done(JSON.parse(buf.slice(0, buf.indexOf('\n'))).result ?? null); } catch { done(null); }
    });
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

async function main() {
  setTimeout(() => process.exit(0), TIMEOUT_MS + 500).unref();
  if (!fs.existsSync(RUNTIME_FILE)) return;
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const call = mirrorFor(JSON.parse(raw || '{}'));
  if (!call) return;
  // No session matched: after /clear both ids are new. Retry naming this hook's own claude
  // process (the one owning the channel). Looked up only now — a process-table query is slow —
  // and never from CLAUDE_PID, which a nested `claude` inherits from its parent.
  if ((await sendMirror(call))?.routed === false) {
    const claudePid = nearestClaude(process.ppid);
    if (claudePid) await sendMirror({ ...call, claudePid, retry: true });
  }
}

if (isMain(import.meta.url)) main().catch(() => {}).finally(() => process.exit(0));
