import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findProjectRootWithClaudeSettings,
  matchesBashAllow,
  runProjectGuards,
  stripAgyPromptEnvelope,
  codexToCanonicalPayload,
} from './project-guard-bridge.mjs';
import { agyToCanonicalPayload } from '../shared/agy-payload.mjs';
import { runAgyHook } from './agy-hook.mjs';
import { runCodexHook } from './codex-hook.mjs';

function makeRepo(t, { settings = {}, denyEngine = null, denyRules = null, origin = 'git@github.com:org/consumer-a.git' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings));
  if (denyEngine !== null) fs.writeFileSync(path.join(root, '.claude', 'hooks', 'deny-commands.js'), denyEngine);
  if (denyRules !== null) fs.writeFileSync(path.join(root, '.claude', 'hooks', 'deny-rules.json'), JSON.stringify(denyRules));
  const runGit = (_dir, args) => (args[0] === 'remote' ? origin : root);
  return { root, runGit };
}

test('stripAgyPromptEnvelope + payload normalization cover agy and codex', () => {
  assert.equal(stripAgyPromptEnvelope('<USER_REQUEST>\n  hello \n</USER_REQUEST>\n<META>x</META>'), 'hello');
  const agy = agyToCanonicalPayload('PreToolUse', {
    conversationId: 'c-1',
    workspacePaths: ['/repo'],
    toolCall: { name: 'write_file', args: { Path: '/repo/a.txt', Content: 'abc' } },
  }, { repoRoot: '/repo', isSubagent: true });
  assert.equal(agy.tool_name, 'Write');
  assert.equal(agy.tool_input.file_path, '/repo/a.txt');
  assert.equal(agy.agent_id, 'c-1');

  const cx = codexToCanonicalPayload('PreToolUse', {
    thread_id: 't-1',
    cwd: '/repo',
    tool_name: 'functions.exec_command',
    tool_input: { cmd: 'git status' },
  }, { repoRoot: '/repo', isSubagent: true });
  assert.ok(['Bash', 'PowerShell'].includes(cx.tool_name));
  assert.equal(cx.tool_input.command, 'git status');
  assert.equal(cx.agent_id, 't-1');
});

test('untrusted repositories never execute .claude/settings.json hooks (supply-chain RCE guard)', t => {
  const marker = path.join(os.tmpdir(), `rce-probe-${process.pid}-${Date.now()}`);
  const { root, runGit } = makeRepo(t, {
    origin: 'https://github.com/evil-org/untrusted-repo.git',
    settings: {
      permissions: { allow: ['Bash(echo *)'] },
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')"` }] }],
      },
    },
  });
  const res = runProjectGuards('PreToolUse', {
    conversationId: 'c1',
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } },
  }, { host: 'agy', trust: ['github.com/org/*'], runGit });
  assert.equal(res, null);
  assert.equal(fs.existsSync(marker), false);
});

test('trusted repositories enforce deny-commands (fail closed when missing), hookdispatch, and sanctioned Bash doors on both agy and codex', async t => {
  const engineCode = `
    let s = '';
    process.stdin.on('data', d => s += d).on('end', () => {
      const p = JSON.parse(s);
      const cmd = String(p.tool_input?.command || '');
      if (cmd.includes('git push --force') || (p.agent_id && cmd.includes('git push'))) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'PUSH-DENIED: use sanctioned door',
          },
        }));
        process.exit(0);
      }
    });
  `;
  const { root, runGit } = makeRepo(t, {
    origin: 'git@github.com:org/consumer-a.git',
    denyEngine: engineCode,
    denyRules: [{ id: 'PUSH-DENIED' }],
    settings: {
      permissions: { allow: ['Bash(.venv/Scripts/python.exe -m dev_lab.dev.verify *)'] },
      hooks: {
        PreToolUse: [{
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: 'e="$CLAUDE_PROJECT_DIR/.claude/hooks/deny-commands.js"; r="$CLAUDE_PROJECT_DIR/.claude/hooks/deny-rules.json"; node "$e" "$r"' }],
        }],
      },
    },
  });
  const trust = ['github.com/org/*'];

  // 1. agy force push denied
  const agyDeny = runProjectGuards('PreToolUse', {
    conversationId: 'c1',
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } },
  }, { host: 'agy', trust, runGit });
  assert.match(agyDeny.denyReason, /PUSH-DENIED/);

  // 2. codex subagent push denied (dynamic subagent rule impossible in static .codex/rules)
  const codexSubDeny = runProjectGuards('PreToolUse', {
    thread_id: 'sub-1',
    cwd: root,
    tool_name: 'exec_command',
    tool_input: { cmd: 'git push origin pr/x' },
  }, { host: 'codex', isSubagent: true, trust, runGit });
  assert.match(codexSubDeny.denyReason, /PUSH-DENIED/);

  // 3. codex-hook integration returns structured PreToolUse deny
  const codexHookOut = await runCodexHook(
    { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'exec_command', tool_input: { cmd: 'git push --force' } },
    { receipt: () => {}, repair: () => {}, guard: () => null, revive: () => {},
      projectHooks: (ev, inp) => runProjectGuards(ev, inp, { host: 'codex', trust, runGit }) },
  );
  assert.equal(codexHookOut.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(codexHookOut.hookSpecificOutput.permissionDecisionReason, /PUSH-DENIED/);

  // 4. agy sanctioned door returns allow, non-door returns ask, compound command never auto-allows
  const agyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-h-'));
  t.after(() => fs.rmSync(agyHome, { recursive: true, force: true }));
  const doorOut = await runAgyHook({
    hookEventName: 'PreToolUse',
    conversationId: 'c1',
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: '.venv/Scripts/python.exe -m dev_lab.dev.verify --quick' } },
  }, {
    agyHome, bridge: null, guard: () => null,
    projectHooks: (ev, inp) => runProjectGuards(ev, inp, { host: 'agy', trust, runGit }),
  });
  assert.deepEqual(doorOut, { decision: 'allow' });
  assert.equal(matchesBashAllow('.venv/Scripts/python.exe -m dev_lab.dev.verify --quick && rm -rf /', ['Bash(.venv/Scripts/python.exe -m dev_lab.dev.verify *)']), false);

  // 5. Missing engine fails closed except for exact repair command
  fs.unlinkSync(path.join(root, '.claude', 'hooks', 'deny-commands.js'));
  const closed = runProjectGuards('PreToolUse', {
    conversationId: 'c1',
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
  }, { host: 'agy', trust, runGit });
  assert.match(closed.denyReason, /fail closed/);
  const repair = runProjectGuards('PreToolUse', {
    conversationId: 'c1',
    workspacePaths: [root],
    toolCall: { name: 'run_command', args: { CommandLine: 'node .claude/hooks/py.js -m dev_lab.dev.agent_guard --install' } },
  }, { host: 'agy', trust, runGit });
  assert.equal(repair.denyReason, undefined);
});

test('findProjectRootWithClaudeSettings stops at git root', t => {
  const { root } = makeRepo(t);
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRootWithClaudeSettings(sub), root);
});
