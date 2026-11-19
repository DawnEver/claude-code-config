// scripts/hooks/project-claude-hooks.mjs — zero-duplication bridge from Antigravity CLI hooks
// onto a repository's own `.claude/settings.json` (`hooks` + `permissions.allow`).
//
// Family repos (motronics-studio, dev-lab, lab-commons, ai-lab, cc-market, ...) declare their
// command-deny engine (`.claude/hooks/deny-commands.js` + `deny-rules.json`), `dev_lab.dev.hookdispatch`
// lifecycle handlers (`codeplace`, `consentguard`, `walls`, `strays`, `handback`, `scratch`,
// `hostalarm`, `forgefeed`, ...), and `permissions.allow` `Bash(...)` doors once in `.claude/settings.json`.
// Running them directly from `agy-hook.mjs` gives Antigravity sessions 100% parity without maintaining
// a duplicate `.agents/hooks.json` in every repo.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const AGY_TO_CLAUDE_TOOL = {
  run_command: () => (process.platform === 'win32' ? 'PowerShell' : 'Bash'),
  write_file: () => 'Write',
  write_to_file: () => 'Write',
  edit_file: () => 'Edit',
  replace_file_content: () => 'Edit',
  multi_replace_file_content: () => 'MultiEdit',
  read_file: () => 'Read',
  view_file: () => 'Read',
  grep_search: () => 'Grep',
  find_by_name: () => 'Glob',
};

const REPAIR_RE = /^[^;&|<>`()\n\r]*-m dev_lab\.dev\.agent_guard --install(?: --force)?$/;
const SHELL_COMPOUND_RE = /[;&|`\n\r<>]|\$\(/;

/** Strip Antigravity's `<USER_REQUEST>...</USER_REQUEST>` prompt wrapper. */
export function stripPromptEnvelope(raw) {
  const t = String(raw ?? '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(t);
  return (m ? m[1] : t).trim();
}

/** Walk upward from `start` to find the nearest checkout root carrying `.claude/settings.json`. */
export function findProjectRootWithClaudeSettings(start) {
  if (!start || typeof start !== 'string') return null;
  let dir = path.resolve(start);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'settings.json'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return null; // reached git root with no .claude/settings.json
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

/** Convert an Antigravity hook input into the Claude Code snake_case hook payload. */
export function toClaudePayload(claudeEvent, input = {}, { repoRoot, isSubagent = false } = {}) {
  const cwd = input.cwd || input.workspacePaths?.[0] || repoRoot || process.cwd();
  const out = {
    session_id: String(input.conversationId ?? ''),
    transcript_path: String(input.transcriptPath ?? ''),
    cwd,
    hook_event_name: claudeEvent,
  };
  if (isSubagent && out.session_id) out.agent_id = out.session_id;
  if (input.continuationActive) out.stop_hook_active = true;
  if (typeof input.lastUserInput === 'string') out.prompt = stripPromptEnvelope(input.lastUserInput);
  const tc = input.toolCall;
  if (tc && typeof tc === 'object') {
    const mapFn = AGY_TO_CLAUDE_TOOL[tc.name];
    out.tool_name = mapFn ? mapFn() : String(tc.name ?? '');
    const a = tc.args && typeof tc.args === 'object' ? tc.args : {};
    const filePath = a.Path ?? a.TargetFile ?? a.AbsolutePath;
    out.tool_input = {
      ...a,
      ...(a.CommandLine !== undefined ? { command: String(a.CommandLine) } : {}),
      ...(filePath !== undefined ? { file_path: String(filePath) } : {}),
      ...(a.Content !== undefined || a.CodeContent !== undefined ? { content: String(a.Content ?? a.CodeContent) } : {}),
      ...(a.Target !== undefined || a.TargetContent !== undefined ? { old_string: String(a.Target ?? a.TargetContent) } : {}),
      ...(a.Replacement !== undefined || a.ReplacementContent !== undefined ? { new_string: String(a.Replacement ?? a.ReplacementContent) } : {}),
    };
  }
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
    // Match `prefix *` both with arguments (`prefix --flag`) and bare (`prefix`).
    const candidates = pat.endsWith(' *') ? [pat, pat.slice(0, -2)] : [pat];
    for (const c of candidates) {
      const re = new RegExp('^' + c.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (re.test(normalized)) return true;
    }
  }
  return false;
}

function buildChildEnv(baseEnv, repoRoot, conversationId) {
  const env = { ...baseEnv, CLAUDE_PROJECT_DIR: repoRoot };
  if (conversationId) env.ANTIGRAVITY_CONVERSATION_ID = String(conversationId);
  // Prevent ambiguous-harness errors in `.claude/hooks/py.js` if an outer shell leaked another host's key.
  if (env.ANTIGRAVITY_CONVERSATION_ID) {
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
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

function runOneHandler(handler, { repoRoot, cwd, payload, payloadJson, childEnv, run = spawnSync }) {
  const cmd = String(handler?.command ?? '').trim();
  if (!cmd) return { code: 0, stdout: '', stderr: '' };
  const timeout = Math.min(Math.max(Number(handler?.timeout || 5) * 1000, 1000), 15000);

  // Fast, cross-platform native execution for dev-lab's fail-closed agent-guard shell wrapper.
  if (cmd.includes('.claude/hooks/deny-commands.js') && cmd.includes('.claude/hooks/deny-rules.json')) {
    const commandText = String(payload?.tool_input?.command ?? '').trim();
    if (REPAIR_RE.test(commandText)) return { code: 0, stdout: '', stderr: '' };
    const engine = path.join(repoRoot, '.claude', 'hooks', 'deny-commands.js');
    const rules = path.join(repoRoot, '.claude', 'hooks', 'deny-rules.json');
    if (!fs.existsSync(engine) || !fs.existsSync(rules)) {
      const repair = `node "${path.join(repoRoot, '.claude', 'hooks', 'py.js')}" -m dev_lab.dev.agent_guard --install`;
      return { code: 2, stdout: '', stderr: `agent-guard: no engine at ${engine} or no rules at ${rules} -- refused (fail closed); repair: ${repair}` };
    }
    const r = run(process.execPath, [engine, rules], { cwd, input: payloadJson, encoding: 'utf8', timeout, env: childEnv, windowsHide: true });
    if (r.error || r.status !== 0) {
      return { code: 2, stdout: '', stderr: `agent-guard: the engine exited ${r.status ?? r.error?.code ?? 1} -- refused (fail closed)` };
    }
    return { code: 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  // Direct Node execution for `node "$CLAUDE_PROJECT_DIR/.claude/hooks/py.js" ...` (no shell startup overhead).
  const nodeArgv = tokenizeNodeCommand(cmd, repoRoot);
  if (nodeArgv) {
    const r = run(process.execPath, nodeArgv, { cwd: repoRoot, input: payloadJson, encoding: 'utf8', timeout, env: childEnv, windowsHide: true });
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  const [shell, args] = process.platform === 'win32' ? ['sh', ['-c', cmd]] : ['sh', ['-c', cmd]];
  const r = run(shell, args, { cwd, input: payloadJson, encoding: 'utf8', timeout, env: childEnv, windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Run a checkout's `.claude/settings*.json` hooks and evaluate `permissions.allow` doors for one agy event.
 * Returns `{ denyReason?, blockReason?, contexts: string[], allowDoor: boolean } | null`.
 */
export function runProjectClaudeHooks(agyEvent, input = {}, { env = process.env, isSubagent = false, run = spawnSync } = {}) {
  const start = input.workspacePaths?.[0] || input.cwd;
  const repoRoot = findProjectRootWithClaudeSettings(start);
  if (!repoRoot) return null;

  const settings = readJsonObject(path.join(repoRoot, '.claude', 'settings.json')) ?? {};
  const localSettings = readJsonObject(path.join(repoRoot, '.claude', 'settings.local.json')) ?? {};
  const allowPatterns = [
    ...(Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []),
    ...(Array.isArray(localSettings.permissions?.allow) ? localSettings.permissions.allow : []),
  ];

  let claudeEvent = null;
  if (agyEvent === 'SessionStart') claudeEvent = 'SessionStart';
  else if (agyEvent === 'PreInvocation' && !Number(input.invocationNum)) claudeEvent = 'UserPromptSubmit';
  else if (agyEvent === 'PreToolUse') claudeEvent = 'PreToolUse';
  else if (agyEvent === 'PostToolUse') claudeEvent = input.error || input.toolCall?.error ? 'PostToolUseFailure' : 'PostToolUse';
  else if (agyEvent === 'Stop' && (!input.terminationReason || input.terminationReason === 'NO_TOOL_CALL'))
    claudeEvent = isSubagent ? 'SubagentStop' : 'Stop';

  if (!claudeEvent) return null;

  const payload = toClaudePayload(claudeEvent, input, { repoRoot, isSubagent });
  const payloadJson = JSON.stringify(payload);
  const childEnv = buildChildEnv(env, repoRoot, input.conversationId);
  const cwd = payload.cwd || repoRoot;

  const groups = [
    ...(Array.isArray(settings.hooks?.[claudeEvent]) ? settings.hooks[claudeEvent] : []),
    ...(Array.isArray(localSettings.hooks?.[claudeEvent]) ? localSettings.hooks[claudeEvent] : []),
  ];

  const denies = [];
  const blocks = [];
  const contexts = [];
  const toolEvent = claudeEvent === 'PreToolUse' || claudeEvent === 'PostToolUse' || claudeEvent === 'PostToolUseFailure';

  for (const group of groups) {
    if (toolEvent && !matcherAdmits(group?.matcher, payload.tool_name)) continue;
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      const res = runOneHandler(h, { repoRoot, cwd, payload, payloadJson, childEnv, run });
      if (res.code === 2) {
        const msg = res.stderr.trim() || 'blocked by project hook';
        if (claudeEvent === 'PreToolUse') denies.push(msg); else blocks.push(msg);
        continue;
      }
      if (res.code !== 0) continue;
      const trimmed = res.stdout.trim();
      if (!trimmed) continue;
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
    }
  }

  const allowDoor = claudeEvent === 'PreToolUse' && !denies.length
    && (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell')
    && matchesBashAllow(payload.tool_input?.command, allowPatterns);

  return {
    ...(denies.length ? { denyReason: denies.join('\n') } : {}),
    ...(blocks.length ? { blockReason: blocks.join('\n') } : {}),
    contexts,
    allowDoor,
  };
}
