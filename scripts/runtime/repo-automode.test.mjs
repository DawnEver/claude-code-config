// Unit tests for scripts/runtime/repo-automode.mjs: a repo's .claude/automode.json reaches
// `claude --settings` only for a trusted origin. Git is injected; repos are temp dirs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { globMatch, originKey, readTrustList, repoAutoModeArgs } from './repo-automode.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

function repo({ origin = 'git@forge.example:team/proj.git', fragment = { autoMode: { allow: ['$defaults', 'x'] } } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'repo-automode-'));
  mkdirSync(join(root, '.claude'));
  if (fragment !== null) writeFileSync(join(root, '.claude', 'automode.json'), JSON.stringify(fragment));
  const runGit = (_cwd, args) => (args[0] === 'rev-parse' ? root : origin);
  return { root, runGit };
}

test('originKey normalizes scp, https and ssh forms to host/path', () => {
  assert.equal(originKey('git@Forge.example:team/proj.git'), 'forge.example/team/proj');
  assert.equal(originKey('https://u@forge.example:443/team/proj.git'), 'forge.example/team/proj');
  assert.equal(originKey('ssh://git@forge.example:22/team/proj'), 'forge.example/team/proj');
  assert.equal(originKey(''), null);
});

test('globMatch: * stays in a segment, ** crosses', () => {
  assert.ok(globMatch('forge.example/team/*', 'forge.example/team/proj'));
  assert.ok(!globMatch('forge.example/team/*', 'forge.example/team/sub/proj'));
  assert.ok(globMatch('forge.example/**', 'forge.example/team/sub/proj'));
  assert.ok(!globMatch('forge.example/team/*', 'forge.example/other/proj'), 'planted control: another org');
});

test('trusted origin with a fragment -> --settings <fragment>', () => {
  const { root, runGit } = repo();
  const r = repoAutoModeArgs({ cwd: root, runGit, trust: ['forge.example/team/*'] });
  assert.deepEqual(r.args, ['--settings', join(root, '.claude', 'automode.json')]);
  assert.match(r.notice, /loaded/);
});

test('untrusted origin -> nothing, and the line names the origin', () => {
  const { root, runGit } = repo({ origin: 'https://evil.example/team/proj.git' });
  const r = repoAutoModeArgs({ cwd: root, runGit, trust: ['forge.example/team/*'] });
  assert.deepEqual(r.args, []);
  assert.match(r.notice, /evil\.example\/team\/proj is not in/);
});

test('empty trust list trusts nothing', () => {
  const { root, runGit } = repo();
  assert.deepEqual(repoAutoModeArgs({ cwd: root, runGit, trust: [] }).args, []);
});

test('no fragment -> nothing', () => {
  const { root, runGit } = repo({ fragment: null });
  const r = repoAutoModeArgs({ cwd: root, runGit, trust: ['**'] });
  assert.deepEqual(r.args, []);
  assert.match(r.notice, /no \.claude\/automode\.json/);
});

test('not a git repo -> nothing', () => {
  const r = repoAutoModeArgs({ cwd: tmpdir(), runGit: () => null, trust: ['**'] });
  assert.deepEqual(r.args, []);
  assert.match(r.notice, /not a git repo/);
});

test('a fragment carrying more than autoMode is refused', () => {
  const { root, runGit } = repo({ fragment: { autoMode: {}, permissions: { allow: ['Bash'] } } });
  const r = repoAutoModeArgs({ cwd: root, runGit, trust: ['**'] });
  assert.deepEqual(r.args, []);
  assert.match(r.notice, /only "autoMode"/);
});

test('an explicit --settings on the command line wins', () => {
  const { root, runGit } = repo();
  assert.deepEqual(repoAutoModeArgs({ cwd: root, runGit, trust: ['**'], extraArgs: ['--settings', 'x'] }).args, []);
});

test('readTrustList: one glob per line, # comments dropped, absent file = []', () => {
  const home = mkdtempSync(join(tmpdir(), 'trust-home-'));
  assert.deepEqual(readTrustList(home), []);
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'trusted-origins'), '# mine\nforge.example/team/*  # team\n\n');
  assert.deepEqual(readTrustList(home), ['forge.example/team/*']);
});

// (iv) One function: buildClaudeInvocation is the only builder of claude args, cc.js the only
// spawner of claude (through ai_lab.session, session-launcher.test.mjs), and the builder calls
// repoAutoModeArgs. Codex has no autoMode.
test('every Claude launch routes through repoAutoModeArgs', () => {
  const launcher = readFileSync(join(here, 'cc-launcher.mjs'), 'utf8');
  assert.match(launcher, /repoSettings = repoAutoModeArgs/);
  assert.match(launcher, /repoSettings\(\{/);
  const cc = readFileSync(join(here, 'cc.js'), 'utf8');
  assert.match(cc, /buildClaudeInvocation\(/);
  assert.match(cc, /sessionSpawn\('claude'/);
  const spawners = execFileSync('git', ['grep', '-l', '-E', String.raw`(prepareSpawn|sessionSpawn|spawn\w*|execFile\w*)\(\s*['"]claude['"]`, '--', '*.js', '*.mjs', ':!*.test.mjs'],
    { cwd: join(here, '..', '..'), encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(spawners, ['scripts/runtime/cc.js'], 'a second claude spawner would bypass the repo autoMode gate');
});
