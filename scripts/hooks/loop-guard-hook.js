#!/usr/bin/env node
// scripts/hooks/loop-guard-hook.js — PreToolUse guard against agents spinning on
// the same action.
//
// Two signals, both scoped to one session and a sliding time/length window:
//
//   exact     identical (tool, normalized input) seen before
//   similar   same tool, input trigram-Jaccard >= similarThreshold
//
// Escalation: at the warn threshold the call still runs but a reminder is injected
// via `additionalContext`; at the deny threshold the hook returns
// `permissionDecision: "deny"`, which reaches the model as a tool error and forces
// it to change approach or report the blocker.
//
// Shared knobs live at harness.loopGuard in the merged env registry. Explicit
// HARNESS_LOOP_GUARD_* env wins, then existing CLAUDE_LOOP_GUARD_* overrides.
//
// Fails open: any parse/IO problem exits 0 with no output, so a bug here can never
// wedge a session.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { isMain } from '../shared/is-main.mjs';
import { ENV_SETTINGS_PATH, readMergedEnvSettings } from '../shared/config.mjs';
import { sessionIdentity } from '../shared/session-identity.mjs';

/** Every knob, with its env override. Counts read as "this call is the Nth such call". */
const DEFAULTS = {
  warnAt: 3, // CLAUDE_LOOP_GUARD_WARN_AT — nth identical call that gets a warning
  denyAt: 4, // CLAUDE_LOOP_GUARD_DENY_AT — nth identical call that gets denied
  similarWarnAt: 4, // CLAUDE_LOOP_GUARD_SIMILAR_WARN_AT
  similarDenyAt: 5, // CLAUDE_LOOP_GUARD_SIMILAR_DENY_AT
  similarThreshold: 0.85, // CLAUDE_LOOP_GUARD_SIMILAR_THRESHOLD — trigram Jaccard
  windowMinutes: 15, // CLAUDE_LOOP_GUARD_WINDOW_MINUTES — older calls stop counting
  maxEntries: 80, // CLAUDE_LOOP_GUARD_MAX_ENTRIES — bound on the state file
  disable: false, // CLAUDE_LOOP_GUARD_DISABLE — 1/true turns the guard off entirely
  // CLAUDE_LOOP_GUARD_EXEMPT — extra comma-separated tool names, added to BASE_EXEMPT
};

// Tools whose whole job is to be polled or repeated. Guarding them would be noise.
const BASE_EXEMPT = [
  'Monitor',
  'TaskOutput',
  'TaskStop',
  'ReadNotifications',
  'ScheduleWakeup',
  'SendMessage',
  'ListAgents',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'ReportFindings',
  'write_stdin',
  'wait',
  'wait_agent',
  'list_agents',
  'sleep',
  'request_user_input',
  'request_user_input_async',
];

const num = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const bool = (raw) => raw === '1' || String(raw).toLowerCase() === 'true';

/** Resolve configuration from an env bag — defaults when unset or malformed. */
function loadConfig(env = process.env, settings = {}) {
  // Explicit host-neutral env > legacy Claude env > merged shared/local config > defaults.
  const value = (key, suffix) => env[`HARNESS_LOOP_GUARD_${suffix}`] ?? env[`CLAUDE_LOOP_GUARD_${suffix}`] ?? settings[key];
  const cfg = {
    warnAt: num(value('warnAt', 'WARN_AT'), DEFAULTS.warnAt),
    denyAt: num(value('denyAt', 'DENY_AT'), DEFAULTS.denyAt),
    similarWarnAt: num(value('similarWarnAt', 'SIMILAR_WARN_AT'), DEFAULTS.similarWarnAt),
    similarDenyAt: num(value('similarDenyAt', 'SIMILAR_DENY_AT'), DEFAULTS.similarDenyAt),
    similarThreshold: num(value('similarThreshold', 'SIMILAR_THRESHOLD'), DEFAULTS.similarThreshold),
    windowMinutes: num(value('windowMinutes', 'WINDOW_MINUTES'), DEFAULTS.windowMinutes),
    maxEntries: num(value('maxEntries', 'MAX_ENTRIES'), DEFAULTS.maxEntries),
    disable: bool(value('disable', 'DISABLE')),
    exempt: new Set([
      ...BASE_EXEMPT,
      ...String(value('exempt', 'EXEMPT') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  };
  cfg.windowMs = cfg.windowMinutes * 60 * 1000;
  // A warn threshold above its deny threshold would silently never fire.
  cfg.warnAt = Math.min(cfg.warnAt, cfg.denyAt);
  cfg.similarWarnAt = Math.min(cfg.similarWarnAt, cfg.similarDenyAt);
  return cfg;
}

function stateFile(scope, dir = path.join(os.tmpdir(), `harness-loop-guard-${process.getuid?.() ?? 'user'}`)) {
  return path.join(dir, `${crypto.createHash('sha256').update(scope).digest('hex')}.json`);
}

/** Stable, whitespace-insensitive rendering of a tool input. */
function normalize(toolInput) {
  const SEP = '|';
  const render = (v) => {
    if (v === null || typeof v !== 'object') {
      return String(v).replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(v)) return v.map(render).join(SEP);
    return Object.keys(v)
      .sort()
      .map((k) => `${k}=${render(v[k])}`)
      .join(SEP);
  };
  return render(toolInput ?? {}).toLowerCase();
}

function trigrams(s) {
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  if (out.size === 0 && s) out.add(s);
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(s.entries) ? s : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch { /* renamed or absent */ } }
}

/** A short exclusive transaction. Contention or stale/unknown ownership fails open. */
function transaction(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
  const lock = `${file}.lock`;
  let fd;
  for (let attempt = 0; attempt < 600; attempt++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (e) {
      if (e.code !== 'EEXIST') return null;
      // Never break another invocation's lock by PID. Between reading an old
      // owner and unlinking, that owner can release and a new one can acquire:
      // deleting the replacement lock loses updates. Abandoned locks fail open;
      // state is per transient execution thread, not a shared security boundary.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (fd === undefined) return null;
  try { return fn(); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

/** Execute one scoped guard transaction. No native thread identity means no shared-parent guess. */
function guardCall(payload, { env = process.env, host, settings, stateDir, now = Date.now() } = {}) {
  try {
    if (settings === undefined) settings = readMergedEnvSettings({ sharedPath: ENV_SETTINGS_PATH })?.harness?.loopGuard ?? {};
    const cfg = loadConfig(env, settings);
    const tool = payload.tool_name;
    const identity = sessionIdentity(env, payload, { host });
    const nativeTool = host === 'codex' ? tool?.replace(/^(?:functions|collaboration|clock)\./, '') : tool;
    if (cfg.disable || !tool || cfg.exempt.has(tool) || cfg.exempt.has(nativeTool) || !identity.threadId) return null;
    const file = stateFile(`${identity.host}:${identity.threadId}`, stateDir);
    return transaction(file, () => {
      const res = evaluate(readState(file).entries, { tool, input: payload.tool_input, now }, cfg);
      writeState(file, { entries: res.entries });
      return res;
    });
  } catch { return null; }
}

/**
 * Core decision, kept pure so tests can drive it without touching disk or stdin.
 * @returns {{verdict:'ok'|'warn'|'deny', reason?:string, entry:object, entries:object[]}}
 */
function evaluate(entries, { tool, input, now }, cfg = loadConfig()) {
  const norm = normalize(input);
  const hash = crypto.createHash('sha1').update(`${tool}\u0000${norm}`).digest('hex').slice(0, 16);
  const grams = trigrams(norm);

  const live = entries.filter((e) => now - e.ts < cfg.windowMs).slice(-cfg.maxEntries);

  let exact = 0;
  let similar = 0;
  for (const e of live) {
    if (e.tool !== tool) continue;
    if (e.hash === hash) {
      exact++;
      continue;
    }
    if (jaccard(grams, new Set(e.grams)) >= cfg.similarThreshold) similar++;
  }

  const entry = { tool, hash, grams: [...grams].slice(0, 400), ts: now };
  const next = [...live, entry].slice(-cfg.maxEntries);
  const mins = Math.round(cfg.windowMinutes);
  const attempt = exact + 1;
  const nearAttempt = similar + 1;

  if (attempt >= cfg.denyAt) {
    return {
      verdict: 'deny',
      reason:
        `Loop guard: this exact ${tool} call has already run ${exact}x in the last ` +
        `${mins} minutes and is blocked. Repeating it will not produce a different ` +
        `result. Change the approach — a different tool, different arguments, or a ` +
        `different angle on the problem — or stop and tell the user what is blocking ` +
        `you and what you need from them.`,
      entry,
      entries: next,
    };
  }
  if (nearAttempt >= cfg.similarDenyAt) {
    return {
      verdict: 'deny',
      reason:
        `Loop guard: ${similar} near-identical ${tool} calls (>=${Math.round(
          cfg.similarThreshold * 100,
        )}% similar input) already ran in the last ${mins} minutes; this one is ` +
        `blocked. Nudging the same input is not progress. Either take a materially ` +
        `different approach or report the blocker to the user.`,
      entry,
      entries: next,
    };
  }
  if (attempt >= cfg.warnAt) {
    return {
      verdict: 'warn',
      reason:
        `Loop guard: this is repeat #${attempt} of an identical ${tool} call, and ` +
        `repeat #${cfg.denyAt} will be blocked. If the previous result was not what ` +
        `you needed, change the approach rather than retrying.`,
      entry,
      entries: next,
    };
  }
  if (nearAttempt >= cfg.similarWarnAt) {
    return {
      verdict: 'warn',
      reason:
        `Loop guard: ${similar} near-identical ${tool} calls already ran recently, ` +
        `and #${cfg.similarDenyAt} will be blocked. Re-running a slight variation ` +
        `rarely helps — consider whether a different tool or a different question ` +
        `would actually move this forward.`,
      entry,
      entries: next,
    };
  }
  return { verdict: 'ok', entry, entries: next };
}

function main(raw, env = process.env, options = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // fail open
  }
  const res = guardCall(payload, { ...options, env });
  if (!res) return;

  if (res.verdict === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: res.reason,
        },
      }),
    );
  } else if (res.verdict === 'warn') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: res.reason,
        },
      }),
    );
  }
}

if (isMain(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      main(raw, process.env, { host: process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : undefined });
    } catch {
      /* fail open */
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

export { evaluate, loadConfig, normalize, jaccard, trigrams, DEFAULTS, BASE_EXEMPT, main, guardCall };
