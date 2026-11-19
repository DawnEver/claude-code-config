import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findProjectRootWithClaudeSettings,
  matchesBashAllow,
  runProjectClaudeHooks,
  stripPromptEnvelope,
  toClaudePayload,
} from './project-claude-hooks.mjs';
import { runAgyHook } from './agy-hook.mjs';

function tempRepo(t, settings, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('stripPromptEnvelope and matchesBashAllow normalize agy prompts and family Bash doors', () => {
  assert.equal(stripPromptEnvelope('<USER_REQUEST>\ntask: integrator\ngo\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'),
    'task: integrator\ngo');
  const allow = [
    'Bash(.venv/Scripts/python.exe -m dev_lab.dev.verify *)',
    'Bash(.venv/Scripts/python.exe -m dev_lab.ops.consent grant *)',
    'Bash(git merge --ff-only *)',
  ];
  assert.equal(matchesBashAllow('.venv\\Scripts\\python.exe -m dev_lab.dev.verify --fast', allow), true);
  assert.equal(matchesBashAllow('.venv/Scripts/python.exe -m dev_lab.dev.verify', allow), true);
  assert.equal(matchesBashAllow('.venv/Scripts/python.exe -m dev_lab.ops.consent grant req.json --code 123456', allow), true);
  assert.equal(matchesBashAllow('.venv/Scripts/python.exe -m dev_lab.dev.verify && rm -rf /', allow), false, 'compound shell never auto-allowed');
  assert.equal(matchesBashAllow('git push --force', allow), false);
});

test('toClaudePayload maps agy tools, args, prompt and subagent agent_id', () => {
  const p = toClaudePayload('PreToolUse', {
    conversationId: 'sub-99',
    workspacePaths: ['/repo'],
    toolCall: { name: 'write_file', args: { Path: '/repo/a.py', Content: 'x = 1\n' } },
  }, { repoRoot: '/repo', isSubagent: true });
  assert.equal(p.tool_name, 'Write');
  assert.equal(p.tool_input.file_path, '/repo/a.py');
  assert.equal(p.tool_input.content, 'x = 1\n');
  assert.equal(p.agent_id, 'sub-99');
});

test('project agent-guard fails closed when missing, allows its own --install door, and enforces deny-commands.js + Stop blocks', async (t) => {
  const guardCmd = 'e="$CLAUDE_PROJECT_DIR/.claude/hooks/deny-commands.js"; r="$CLAUDE_PROJECT_DIR/.claude/hooks/deny-rules.json"; node "$e" "$r"';
  const root = tempRepo(t, {
    permissions: { allow: ['Bash(.venv/Scripts/python.exe -m dev_lab.dev.verify *)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: guardCmd, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-gate.js"', timeout: 5 }] }],
    },
  }, {
    '.claude/hooks/stop-gate.js': 'process.stdout.write(JSON.stringify({ decision: "block", reason: "strays: clean scratch first" }));',
  });

  assert.equal(findProjectRootWithClaudeSettings(path.join(root, 'sub', 'dir')), root);

  // 1. Missing engine/rules -> fail closed, EXCEPT the agent_guard --install repair door!
  const missing = runProjectClaudeHooks('PreToolUse', {
    conversationId: 'c1', workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
  });
  assert.match(missing.denyReason, /fail closed/);
  const repair = runProjectClaudeHooks('PreToolUse', {
    conversationId: 'c1', workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: '.venv/Scripts/python.exe -m dev_lab.dev.agent_guard --install' } },
  });
  assert.equal(repair.denyReason, undefined);

  // 2. Install a real mini engine + rules: refuses `git push --force`, allows `dev_lab.dev.verify` door -> decision: 'allow' in runAgyHook.
  fs.writeFileSync(path.join(root, '.claude', 'hooks', 'deny-rules.json'), JSON.stringify([{ pattern: 'git push --force', reason: 'PUSH-FORCE: never force-push' }]));
  fs.writeFileSync(path.join(root, '.claude', 'hooks', 'deny-commands.js'), `
    const fs = require('fs');
    const rules = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const p = JSON.parse(fs.readFileSync(0, 'utf8'));
    const cmd = String(p.tool_input?.command || '');
    for (const r of rules) if (cmd.includes(r.pattern)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } }));
    }
  `);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-h-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hookDeps = {
    agyHome: home, bridge: null, guard: async () => null, notify: async () => null, remind: async () => null,
    projectHooks: (ev, inp) => runProjectClaudeHooks(ev, inp),
  };

  const denied = await runAgyHook({
    hookEventName: 'PreToolUse', conversationId: 'c1', workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } },
  }, hookDeps);
  assert.deepEqual(denied, { decision: 'deny', reason: 'PUSH-FORCE: never force-push' });

  const allowedDoor = await runAgyHook({
    hookEventName: 'PreToolUse', conversationId: 'c1', workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: '.venv/Scripts/python.exe -m dev_lab.dev.verify --fast' } },
  }, hookDeps);
  assert.deepEqual(allowedDoor, { decision: 'allow' }, 'sanctioned family door auto-allowed');

  const unalowedNormal = await runAgyHook({
    hookEventName: 'PreToolUse', conversationId: 'c1', workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'echo custom' } },
  }, hookDeps);
  assert.deepEqual(unalowedNormal, { decision: 'ask' }, 'non-door command defers to user toolPermission');

  // 3. Project Stop gate blocks turn completion until continuationActive.
  const stopBlocked = await runAgyHook({
    hookEventName: 'Stop', conversationId: 'c1', workspacePaths: [root], terminationReason: 'NO_TOOL_CALL',
  }, hookDeps);
  assert.deepEqual(stopBlocked, { decision: 'continue', reason: 'strays: clean scratch first' });
});

test('live motronics-studio integration (when present in LAB_COMMONS_SIBLINGS): enforces real deny-commands.js + family doors', (t) => {
  const sib = String(process.env.LAB_COMMONS_SIBLINGS ?? '').split(',').map((s) => s.split('=')).find(([k]) => k === 'consumer-a')?.[1];
  if (!sib || !fs.existsSync(path.join(sib, '.claude', 'hooks', 'deny-commands.js'))) {
    return t.skip('consumer-a checkout with installed agent-guard not present on this host');
  }
  // Subagent attempting raw `git push` -> refused by SUBAGENT-NO-PUSH / NETWORK-VERB in motronics-studio's real engine!
  const refused = runProjectClaudeHooks('PreToolUse', {
    conversationId: 'subagent-live-check',
    workspacePaths: [sib],
    cwd: sib,
    toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } },
  }, { isSubagent: true });
  assert.ok(refused?.denyReason, 'real motronics-studio engine refuses git push --force');

  // Sanctioned motronics CLI door -> passes guard and matches permissions.allow!
  const door = runProjectClaudeHooks('PreToolUse', {
    conversationId: 'main-live-check',
    workspacePaths: [sib],
    cwd: sib,
    toolCall: { name: 'run_command', args: { CommandLine: '.venv/Scripts/python.exe -m motronics case list --all' } },
  }, { isSubagent: false });
  assert.equal(door?.denyReason, undefined);
  assert.equal(door?.allowDoor, true);
});
