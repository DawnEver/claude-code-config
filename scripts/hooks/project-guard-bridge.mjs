// scripts/hooks/project-guard-bridge.mjs — trusted host-adapter bridge onto a repository's
// canonical `.claude/settings*.json` guards and sanctioned doors.
//
// Family repositories declare their guard rules (`.claude/hooks/deny-commands.js` + `deny-rules.json`),
// lifecycle dispatcher (`.claude/hooks/py.js -m dev_lab.dev.hookdispatch <Event>`), and sanctioned
// doors (`permissions.allow` `Bash(...)`) once under `.claude/`. Rather than duplicating host-specific
// hook manifests in every repository or leaving dynamic path/subagent/consent rules unjudged on Codex
// and Antigravity, both `agy-hook.mjs` and `codex-hook.mjs` normalize their host wire payloads onto
// the canonical hook contract here — repo hook code is gated strictly by `~/.claude/trusted-origins`;
// every other repo is judged by the FAMILY deny rows from the machine dev-lab install (D99), never its own copy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isTrustedRepo } from '../runtime/repo-automode.mjs';
import { agyToCanonicalPayload, stripAgyPromptEnvelope } from '../shared/agy-payload.mjs';
import { recordedPython } from '../shared/provider-cache.mjs';

export { stripAgyPromptEnvelope };

const REPAIR_RE = /^[^;&|<>`()\n\r]*-m dev_lab\.dev\.agent_guard --install(?: --force)?$/;
const SHELL_COMPOUND_RE = /[;&|`\n\r<>]|\$\(/;

const CODEX_TO_CANONICAL_TOOL = {
  exec_command: () => (process.platform === 'win32' ? 'PowerShell' : 'Bash'),
  shell: () => (process.platform === 'win32' ? 'PowerShell' : 'Bash'),
  shell_command: () => (process.platform === 'win32' ? 'PowerShell' : 'Bash'),
  local_shell: () => (process.platform === 'win32' ? 'PowerShell' : 'Bash'),
  apply_patch: () => 'Edit',
};

/** Walk upward from `start` to find the nearest checkout root carrying `.claude/settings.json`. */
export function findProjectRootWithClaudeSettings(start) {
  if (!start || typeof start !== 'string') return null;
  let dir = path.resolve(start);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'settings.json'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readJsonObject(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Normalize a Codex native hook input onto the canonical Claude snake_case hook payload. */
export function codexToCanonicalPayload(claudeEvent, input = {}, { repoRoot, env = process.env, isSubagent = false } = {}) {
  const cwd = input.cwd || repoRoot || process.cwd();
  const rawTool = String(input.tool_name ?? '').split('.').at(-1);
  const mapFn = CODEX_TO_CANONICAL_TOOL[rawTool];
  const toolName = mapFn ? mapFn() : rawTool;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cmdArray = Array.isArray(ti.cmd) ? ti.cmd.join(' ') : Array.isArray(ti.command) ? ti.command.join(' ') : undefined;
  const command = typeof ti.command === 'string' ? ti.command
    : typeof ti.cmd === 'string' ? ti.cmd
      : cmdArray;
  const sessionId = String(input.thread_id || input.session_id || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || '');
  const out = {
    ...input,
    session_id: sessionId,
    cwd,
    hook_event_name: claudeEvent,
    ...(toolName ? { tool_name: toolName } : {}),
    ...(Object.keys(ti).length || command !== undefined
      ? { tool_input: { ...ti, ...(command !== undefined ? { command } : {}) } }
      : {}),
  };
  if (isSubagent && sessionId && !out.agent_id) out.agent_id = sessionId;
  return out;
}

function matcherAdmits(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(String(toolName ?? '')); }
  catch { return String(matcher).split('|').includes(String(toolName ?? '')); }
}

/** Whether a single simple shell command matches a Claude `Bash(<glob>)` allow pattern. */
export function matchesBashAllow(command, allowPatterns = []) {
  const cmd = String(command ?? '').trim();
  if (!cmd || SHELL_COMPOUND_RE.test(cmd)) return false;
  const normalized = cmd.replace(/\\/g, '/');
  for (const raw of allowPatterns) {
    const m = /^Bash\(([\s\S]+)\)$/.exec(String(raw ?? '').trim());
    if (!m) continue;
    const pat = m[1].trim().replace(/\\/g, '/');
    const candidates = pat.endsWith(' *') ? [pat, pat.slice(0, -2)] : [pat];
    for (const c of candidates) {
      const re = new RegExp('^' + c.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (re.test(normalized)) return true;
    }
  }
  return false;
}

function buildChildEnv(baseEnv, repoRoot, host, sessionId) {
  const env = { ...baseEnv, CLAUDE_PROJECT_DIR: repoRoot };
  if (host === 'agy') {
    if (sessionId) env.ANTIGRAVITY_CONVERSATION_ID = String(sessionId);
    if (env.ANTIGRAVITY_CONVERSATION_ID) {
      delete env.CLAUDE_CODE_SESSION_ID;
      delete env.CODEX_THREAD_ID;
      delete env.CODEX_SESSION_ID;
    }
  } else if (host === 'codex') {
    if (sessionId && !env.CODEX_THREAD_ID) env.CODEX_THREAD_ID = String(sessionId);
    if (env.CODEX_THREAD_ID) {
      delete env.CLAUDE_CODE_SESSION_ID;
      delete env.ANTIGRAVITY_CONVERSATION_ID;
    }
  }
  return env;
}

function tokenizeNodeCommand(cmd, repoRoot) {
  const expanded = cmd
    .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, repoRoot)
    .trim();
  const tokens = [...expanded.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (tokens[0] !== 'node' || /[;&|<>`$()]/.test(expanded.replace(/"[^"]*"|'[^']*'/g, ''))) return null;
  const script = path.isAbsolute(tokens[1] ?? '') ? tokens[1] : path.resolve(repoRoot, tokens[1] ?? '');
  return [script, ...tokens.slice(2)];
}

/** Run dev-lab's declarative shell-deny guard directly from its data files (fail closed). */
function runDeclarativeShellGuard({ repoRoot, cwd, payload, payloadJson, childEnv, timeout = 5000, run = spawnSync }) {
  const commandText = String(payload?.tool_input?.command ?? '').trim();
  if (REPAIR_RE.test(commandText)) return { code: 0, stdout: '', stderr: '' };
  const engine = path.join(repoRoot, '.claude', 'hooks', 'deny-commands.js');
  const rules = path.join(repoRoot, '.claude', 'hooks', 'deny-rules.json');
  if (!fs.existsSync(engine) || !fs.existsSync(rules)) {
    const repair = `node "${path.join(repoRoot, '.claude', 'hooks', 'py.js')}" -m dev_lab.dev.agent_guard --install`;
    return { code: 2, stdout: '', stderr: `agent-guard: no engine at ${engine} or no rules at ${rules} -- refused (fail closed); repair: ${repair}` };
  }
  const r = run(process.execPath, [engine, rules], { cwd, input: payloadJson, encoding: 'utf8', timeout, env: childEnv, windowsHide: true });
  if (r.status === 2) return { code: 2, stdout: r.stdout || '', stderr: r.stderr || '' };
  if (r.error || r.status !== 0) {
    return { code: 2, stdout: '', stderr: `agent-guard: the engine exited ${r.status ?? r.error?.code ?? 1} -- refused (fail closed)` };
  }
  return { code: 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const isShellGuardWrapper = (cmd) =>
  cmd.includes('.claude/hooks/deny-commands.js') && cmd.includes('.claude/hooks/deny-rules.json');

function runOneHandler(handler, { repoRoot, cwd, payload, payloadJson, childEnv, run = spawnSync }) {
  const cmd = String(handler?.command ?? '').trim();
  if (!cmd) return { code: 0, stdout: '', stderr: '' };
  const timeout = Math.min(Math.max(Number(handler?.timeout || 5) * 1000, 1000), 15000);
  if (isShellGuardWrapper(cmd)) {
    return runDeclarativeShellGuard({ repoRoot, cwd, payload, payloadJson, childEnv, timeout, run });
  }
  const nodeArgv = tokenizeNodeCommand(cmd, repoRoot);
  if (nodeArgv) {
    const r = run(process.execPath, nodeArgv, { cwd: repoRoot, input: payloadJson, encoding: 'utf8', timeout, env: childEnv, windowsHide: true });
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  const r = run('sh', ['-c', cmd], { cwd, input: payloadJson, encoding: 'utf8', timeout, env: childEnv, windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** The canonical (Claude) events a host's installed events reach, as a parent and as a subagent. */
export function canonicalEventsFor(host, hostEvents) {
  const out = new Set();
  for (const e of hostEvents) for (const sub of [false, true]) {
    const c = resolveCanonicalEvent(host, e, { invocationNum: 0 }, sub);
    if (c) out.add(c);
  }
  return out;
}

const FAMILY_REMEDY = 'run node scripts/setup/setup.js in cc-config (records the dev-lab python), or install dev-lab';

/**
 * The family deny engine and rows from this MACHINE's dev-lab install (D99): one source,
 * `python -m dev_lab.dev.agenthooks --path / --family-rules`, cached by engine path + mtime.
 * Never a repository's copy. Returns {engine, rules} or {error}.
 */
export function installedFamilyGuard({ python = recordedPython(), run = spawnSync,
  cacheDir = path.join(os.homedir(), '.claude', 'cache') } = {}) {
  if (!python) return { error: 'no recorded python' };
  const door = args => run(python, ['-m', 'dev_lab.dev.agenthooks', ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const where = door(['--path']);
  if (where.error || where.status !== 0) return { error: `dev_lab.dev.agenthooks --path exited ${where.status ?? where.error?.code}` };
  const engine = where.stdout.trim();
  let stamp;
  try { stamp = `${engine}|${fs.statSync(engine).mtimeMs}`; } catch { return { error: `no engine at ${engine}` }; }
  const rules = path.join(cacheDir, 'family-deny-rules.json');
  const stampFile = `${rules}.stamp`;
  try { if (fs.readFileSync(stampFile, 'utf8') === stamp && fs.existsSync(rules)) return { engine, rules }; } catch { /* refresh */ }
  const rows = door(['--family-rules']);
  if (rows.error || rows.status !== 0) return { error: `dev_lab.dev.agenthooks --family-rules exited ${rows.status ?? rows.error?.code}` };
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(rules, rows.stdout);
  fs.writeFileSync(stampFile, stamp);
  return { engine, rules };
}

/** An untrusted (or repo-less) call: only the installed family rows judge it, fail closed. */
function runFamilyGuard(hostEvent, input, { host, env, isSubagent, run, family, cwd }) {
  if (resolveCanonicalEvent(host, hostEvent, input, isSubagent) !== 'PreToolUse') return null;
  const payload = host === 'agy'
    ? agyToCanonicalPayload('PreToolUse', input, { repoRoot: cwd, isSubagent })
    : codexToCanonicalPayload('PreToolUse', input, { repoRoot: cwd, env, isSubagent });
  if (payload.tool_name !== 'Bash' && payload.tool_name !== 'PowerShell') return null;
  const guard = family();
  if (guard.error) return { denyReason: `agent-guard: family deny rows unavailable: ${guard.error} -- refused (fail closed); ${FAMILY_REMEDY}`, contexts: [], allowDoor: false };
  const r = run(process.execPath, [guard.engine, guard.rules], { cwd: payload.cwd || cwd, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.error || (r.status !== 0 && r.status !== 2)) return { denyReason: `agent-guard: the family engine exited ${r.status ?? r.error?.code} -- refused (fail closed)`, contexts: [], allowDoor: false };
  let reason = r.status === 2 ? (r.stderr || '').trim() : '';
  try {
    const spec = JSON.parse((r.stdout || '').trim() || '{}').hookSpecificOutput ?? {};
    if (spec.permissionDecision === 'deny') reason = String(spec.permissionDecisionReason || 'denied by family row');
  } catch { /* plain text: no decision */ }
  return reason ? { denyReason: reason, contexts: [], allowDoor: false } : null;
}

function resolveCanonicalEvent(host, hostEvent, input, isSubagent) {
  if (host === 'agy') {
    if (hostEvent === 'SessionStart') return 'SessionStart';
    if (hostEvent === 'PreInvocation' && !Number(input.invocationNum)) return 'UserPromptSubmit';
    if (hostEvent === 'PreToolUse') return 'PreToolUse';
    if (hostEvent === 'PostToolUse') return input.error || input.toolCall?.error ? 'PostToolUseFailure' : 'PostToolUse';
    if (hostEvent === 'Stop' && (!input.terminationReason || input.terminationReason === 'NO_TOOL_CALL')) {
      return isSubagent ? 'SubagentStop' : 'Stop';
    }
    return null;
  }
  if (host === 'codex') {
    if (hostEvent === 'SessionStart') return 'SessionStart';
    if (hostEvent === 'PreToolUse') return 'PreToolUse';
    if (hostEvent === 'UserPromptSubmit') return 'UserPromptSubmit';
    if (hostEvent === 'PostToolUse') return 'PostToolUse';
    if (hostEvent === 'Stop') return isSubagent ? 'SubagentStop' : 'Stop';
    if (hostEvent === 'SessionEnd') return 'SessionEnd';
    return null;
  }
  return hostEvent;
}

/**
 * Run a trusted checkout's `.claude/settings*.json` hooks and evaluate `permissions.allow` doors.
 * Untrusted repositories (origin absent from `~/.claude/trusted-origins`) return `null` without
 * executing any repository code.
 *
 * Returns `{ denyReason?, blockReason?, contexts: string[], allowDoor: boolean } | null`.
 */
export function runProjectGuards(hostEvent, input = {}, {
  host = 'agy',
  env = process.env,
  home = os.homedir(),
  trust,
  runGit,
  isSubagent = false,
  run = spawnSync,
  family = installedFamilyGuard,
} = {}) {
  const start = input.workspacePaths?.[0] || input.cwd;
  const repoRoot = findProjectRootWithClaudeSettings(start);
  const trustOpts = { home, ...(trust !== undefined ? { trust } : {}), ...(runGit ? { runGit } : {}) };
  if (!repoRoot || !isTrustedRepo(repoRoot, trustOpts).trusted) {
    return runFamilyGuard(hostEvent, input, { host, env, isSubagent, run, family, cwd: repoRoot || start || process.cwd() });
  }

  const claudeEvent = resolveCanonicalEvent(host, hostEvent, input, isSubagent);
  if (!claudeEvent) return null;

  const settings = readJsonObject(path.join(repoRoot, '.claude', 'settings.json')) ?? {};
  const localSettings = readJsonObject(path.join(repoRoot, '.claude', 'settings.local.json')) ?? {};
  const allowPatterns = [
    ...(Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []),
    ...(Array.isArray(localSettings.permissions?.allow) ? localSettings.permissions.allow : []),
  ];

  const payload = host === 'agy'
    ? agyToCanonicalPayload(claudeEvent, input, { repoRoot, isSubagent })
    : codexToCanonicalPayload(claudeEvent, input, { repoRoot, env, isSubagent });
  const payloadJson = JSON.stringify(payload);
  const childEnv = buildChildEnv(env, repoRoot, host, payload.session_id);
  const cwd = payload.cwd || repoRoot;

  const groups = [
    ...(Array.isArray(settings.hooks?.[claudeEvent]) ? settings.hooks[claudeEvent] : []),
    ...(Array.isArray(localSettings.hooks?.[claudeEvent]) ? localSettings.hooks[claudeEvent] : []),
  ];

  const denies = [];
  const blocks = [];
  const contexts = [];
  const toolEvent = claudeEvent === 'PreToolUse' || claudeEvent === 'PostToolUse' || claudeEvent === 'PostToolUseFailure';
  const isShellTool = payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell';
  let shellGuardRan = false;

  const collectResult = (res) => {
    if (res.code === 2) {
      const msg = res.stderr.trim() || 'blocked by project hook';
      if (claudeEvent === 'PreToolUse') denies.push(msg); else blocks.push(msg);
      return;
    }
    if (res.code !== 0) return;
    const trimmed = res.stdout.trim();
    if (!trimmed) return;
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch { /* plain text */ }
    if (parsed && typeof parsed === 'object') {
      const spec = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === 'object' ? parsed.hookSpecificOutput : {};
      if (spec.permissionDecision === 'deny') denies.push(String(spec.permissionDecisionReason || 'denied by project hook'));
      if (parsed.decision === 'block') blocks.push(String(parsed.reason || 'blocked by project hook'));
      if (spec.additionalContext) contexts.push(String(spec.additionalContext));
      if (parsed.systemMessage) contexts.push(String(parsed.systemMessage));
    } else if (claudeEvent === 'SessionStart' || claudeEvent === 'UserPromptSubmit') {
      contexts.push(trimmed);
    }
  };

  for (const group of groups) {
    if (toolEvent && !matcherAdmits(group?.matcher, payload.tool_name)) continue;
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (isShellGuardWrapper(String(h?.command ?? ''))) shellGuardRan = true;
      collectResult(runOneHandler(h, { repoRoot, cwd, payload, payloadJson, childEnv, run }));
    }
  }

  // Declarative first-principles fallback: if a trusted repo ships `.claude/hooks/deny-rules.json`
  // and no settings row ran the shell guard yet, enforce it fail-closed on PreToolUse shell calls.
  if (claudeEvent === 'PreToolUse' && isShellTool && !shellGuardRan
    && fs.existsSync(path.join(repoRoot, '.claude', 'hooks', 'deny-rules.json'))) {
    collectResult(runDeclarativeShellGuard({ repoRoot, cwd, payload, payloadJson, childEnv, run }));
  }

  const allowDoor = claudeEvent === 'PreToolUse' && !denies.length && isShellTool
    && matchesBashAllow(payload.tool_input?.command, allowPatterns);

  return {
    ...(denies.length ? { denyReason: denies.join('\n') } : {}),
    ...(blocks.length ? { blockReason: blocks.join('\n') } : {}),
    contexts,
    allowDoor,
  };
}
