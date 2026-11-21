#!/usr/bin/env node
// code-ask-hook.js — Stop hook: an assistant never asks the user for a one-time code before its preflight is green.
//
//   node ~/.claude/scripts/hooks/code-ask-hook.js      (Stop; the hook payload on stdin)
//
// Measured 2026-11-20: codes were asked, then the call carrying them failed on a cause checkable without one (an
// issuer with no version handshake, a host key never enrolled, a request for a task identity that had changed).
// dev-lab's preflight proves the call can succeed and writes a short-lived receipt; this hook is the other half:
// when the final message ASKS the user for a code (TOTP / consent / one-time / cluster code), it reads the fresh
// receipts through dev-lab's own CLI -- the narrow interface, never its state layout --
//   node <cwd>/.claude/hooks/py.js -m dev_lab.ops.consent receipts     (exit 0: one is fresh; 1: none)
// and blocks the stop unless one is fresh, naming the preflight door. A checkout with no dev-lab door
// (.claude/hooks/py.js absent) has no consent machinery to preflight: the stop passes.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from '../shared/is-main.mjs';

/** The preflight door a blocked ask is pointed at (dev-lab's PREFLIGHT_DOOR, and the break-glass verb's own). */
export const PREFLIGHT_DOOR = 'python -m dev_lab.ops.consent preflight <request.json> '
  + '(break-glass: python -m dev_lab.dev.forge breakglass open --preflight --hours H --max-merges N)';

// A code the user holds: a kind of code named, then the word itself.
const CODE = /\b(?:totp|one[- ]time|consent|cluster|authenticator|2fa|mfa|6[- ]digit|six[- ]digit|verification)\s+(?:code|token|pin)\b/i;
// An ask aimed at the user.
const ASK = /\b(?:give|send|paste|provide|share|enter|type|reply|need|please|what is|what's)\b/i;
const USER = /\b(?:you|your|me)\b|\?/i;

/** True when `text` asks the user for a one-time code: one sentence names the code, asks, and addresses the user. */
export function asksForCode(text) {
  return String(text ?? '').split(/(?<=[.!?\n])\s+/).some((s) => CODE.test(s) && ASK.test(s) && USER.test(s));
}

/** The final assistant message: the payload's own, else the transcript's last assistant text. */
export function finalMessage(payload) {
  if (typeof payload?.last_assistant_message === 'string') return payload.last_assistant_message;
  let lines = [];
  try { lines = fs.readFileSync(payload.transcript_path, 'utf8').split('\n'); } catch { return ''; }
  for (const line of lines.reverse()) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : String(content ?? '');
    if (text.trim()) return text;
  }
  return '';
}

/** dev-lab's answer on the fresh receipts in `cwd`: {status, said}; status null when no dev-lab door is there. */
export function readReceipts(cwd, { run = spawnSync } = {}) {
  const door = path.join(cwd, '.claude', 'hooks', 'py.js');
  if (!fs.existsSync(door)) return { status: null, said: '' };
  const res = run(process.execPath, [door, '-m', 'dev_lab.ops.consent', 'receipts'],
    { cwd, encoding: 'utf8', timeout: 4000, windowsHide: true });
  return { status: res.status, said: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

/** The Stop hook's output for `payload`: null to let it stop, else the block. */
export function decide(payload, { receipts = readReceipts } = {}) {
  if (!asksForCode(finalMessage(payload))) return null;
  const { status, said } = receipts(payload?.cwd || process.cwd());
  if (status === null || status === 0) return null;
  const why = status === 1 ? 'no fresh preflight receipt' : `dev-lab could not list the receipts (exit ${status}; update dev-lab here)`;
  return {
    decision: 'block',
    reason: `NO-CODE-ASK-WITHOUT-PREFLIGHT: this message asks the user for a code, but ${why}. Run the preflight `
      + `first -- ${PREFLIGHT_DOOR} -- fix every blocker it names, and ask only once it is green (the receipt lives `
      + `minutes). If it cannot be made green, report the blocker instead of asking.${said ? `\n${said}` : ''}`,
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { return; }
  const out = decide(payload);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (isMain(import.meta.url)) main().catch(() => {});
