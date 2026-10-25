// `--continue` and `resume --last` name no id, so the launcher resolves them to the transcript they would take and
// hands ai-lab-session `--resume <id>` / `resume <id>`: a continued conversation keeps its LAB_SESSION.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeProjectSlug, claudeResumeArgs, codexResumeArgs } from './vendor-session.mjs';
import { buildClaudeInvocation } from '../runtime/cc-launcher.mjs';
import { buildCodexInvocation } from '../runtime/codex-launcher.mjs';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function claudeDir(cwd, ids, configDir = mkdtempSync(join(tmpdir(), 'vs-claude-'))) {
  const dir = join(configDir, 'projects', claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  ids.forEach((id, i) => {
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, '{}\n');
    utimesSync(file, 1000 + i, 1000 + i);
  });
  return configDir;
}

function codexHome(ids) {
  const home = mkdtempSync(join(tmpdir(), 'vs-codex-'));
  const day = join(home, 'sessions', '2026', '10', '21');
  mkdirSync(day, { recursive: true });
  ids.forEach((id, i) => {
    const file = join(day, `rollout-2026-10-21T10-0${i}-00-${id}.jsonl`);
    writeFileSync(file, '{}\n');
    utimesSync(file, 1000 + i, 1000 + i);
  });
  return home;
}

test('--continue / -c become --resume <the cwd\'s newest transcript> (planted control: another cwd keeps -c)', () => {
  const configDir = claudeDir('C:\\work\\repo', [A, B]);
  const seams = { configDir, cwd: 'C:\\work\\repo' };
  assert.deepEqual(claudeResumeArgs(['--continue'], seams), ['--resume', B]);
  assert.deepEqual(claudeResumeArgs(['-c', '--model', 'opus'], seams), ['--resume', B, '--model', 'opus']);
  assert.deepEqual(claudeResumeArgs(['-c'], { configDir, cwd: 'C:\\elsewhere' }), ['-c']);
});

test('a named resume, the picker and a fresh launch pass through untouched', () => {
  const seams = { configDir: claudeDir('/w', [A]), cwd: '/w' };
  for (const args of [['--resume', A], ['--resume'], [], ['mcp', 'list']]) assert.deepEqual(claudeResumeArgs(args, seams), args);
});

test('codex: resume --last becomes resume <the newest rollout>; resume <id> and a fresh launch pass through', () => {
  const home = codexHome([A, B]);
  assert.deepEqual(codexResumeArgs(['resume', '--last'], { codexHome: home }), ['resume', B]);
  assert.deepEqual(codexResumeArgs(['resume', A], { codexHome: home }), ['resume', A]);
  assert.deepEqual(codexResumeArgs([], { codexHome: home }), []);
  assert.deepEqual(codexResumeArgs(['resume', '--last'], { codexHome: codexHome([]) }), ['resume', '--last']);
});

test('the launchers resolve the continuation and issue no LAB_SESSION of their own (ai-lab-session does)', () => {
  const home = mkdtempSync(join(tmpdir(), 'vs-home-'));
  claudeDir('/w', [A, B], join(home, '.claude'));
  const claude = buildClaudeInvocation({ provider: null, extraArgs: ['-c'], envSettingsPath: '/nonexistent', home, cwd: '/w',
    machine: null, repoSettings: () => ({ args: [] }) });
  assert.deepEqual(claude.args.slice(-2), ['--resume', B]);
  assert.equal(claude.env.LAB_SESSION, process.env.LAB_SESSION);
  const codex = buildCodexInvocation({ provider: null, extraArgs: ['resume', '--last'], envSettingsPath: '/nonexistent',
    codexHome: codexHome([A, B]), baseEnv: {} });
  assert.deepEqual(codex.args.slice(-2), ['resume', B]);
  assert.equal(codex.env.LAB_SESSION, undefined);
});
