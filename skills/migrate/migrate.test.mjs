import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CLAUDE_LINKS, CODEX_LINKS, discoverCodexSkillLinks, getCodexLinks, ensureRealDir } from '../../scripts/setup/setup.js';
import { findOrphanedLinks, discoverProjectMigrators, ensureGitignoreTemplate, migrateGitignore, reposNeedingTemplate, migrateRetiredPlugins } from './migrate.js';
import { locateBinDir, resolveAliasBinDirs } from '../../scripts/setup/install-shell-aliases.js';

describe('findOrphanedLinks', () => {
  let tmpDir, sourceDir, baseDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
    sourceDir = path.join(tmpDir, 'repo');
    baseDir = path.join(tmpDir, 'claude');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'CURRENT.md'), 'current');
    fs.writeFileSync(path.join(sourceDir, 'OLD.md'), 'old');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty when only current links exist', () => {
    fs.symlinkSync(path.join(sourceDir, 'CURRENT.md'), path.join(baseDir, 'CLAUDE.md'));
    const links = [{ src: 'CURRENT.md', dest: 'CLAUDE.md', type: 'file' }];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('detects a top-level symlink no longer in CLAUDE_LINKS', () => {
    fs.symlinkSync(path.join(sourceDir, 'CURRENT.md'), path.join(baseDir, 'CLAUDE.md'));
    fs.symlinkSync(path.join(sourceDir, 'OLD.md'), path.join(baseDir, 'OLD.md'));
    const links = [{ src: 'CURRENT.md', dest: 'CLAUDE.md', type: 'file' }];
    const orphans = findOrphanedLinks({ baseDir, links, sourceDir });
    assert.deepEqual(orphans.map(o => o.rel), ['OLD.md']);
  });

  test('leaves a link into an outside sync payload alone', () => {
    // base:'sync' entries resolve outside the repo. Deleting them would destroy the live
    // config, so they must never be reported — this guards that filter against refactors.
    const payload = path.join(tmpDir, 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'claude_settings.json'), '{}');
    fs.symlinkSync(path.join(payload, 'claude_settings.json'), path.join(baseDir, 'settings.json'));

    const links = [{ src: 'claude_settings.json', dest: 'settings.json', type: 'file', base: 'sync' }];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('detects a DANGLING link that is no longer in the link tables', () => {
    // The real case this fixes: ~/.claude/models.md pointed into a repo location that was
    // deleted. realpathSync throws, and the old code skipped it, so nothing could clean it.
    fs.symlinkSync(path.join(tmpDir, 'gone', 'models.md'), path.join(baseDir, 'models.md'));
    const links = [{ src: 'CURRENT.md', dest: 'CLAUDE.md', type: 'file' }];
    const orphans = findOrphanedLinks({ baseDir, links, sourceDir });
    assert.deepEqual(orphans.map(o => o.rel), ['models.md']);
    assert.equal(orphans[0].dangling, true);
  });

  test('recurses into a nested container and finds an orphan there', () => {
    // dest comes from path.join, so on Windows it is 'skills\\git-tidy' while the scanner
    // builds rel as 'skills/git-tidy'. Comparing the raw forms left containerPrefixes
    // EMPTY, so ~/.codex/skills/ was never scanned and leftovers there needed manual
    // cleanup. This test fails on Windows before the normalisation.
    const nested = path.join(baseDir, 'skills');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'skills', 'git-tidy'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'skills', 'retired'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : undefined;
    fs.symlinkSync(path.join(sourceDir, 'skills', 'git-tidy'), path.join(nested, 'git-tidy'), linkType);
    fs.symlinkSync(path.join(sourceDir, 'skills', 'retired'), path.join(nested, 'retired'), linkType);

    const links = [{ src: path.join('skills', 'git-tidy'), dest: path.join('skills', 'git-tidy'), type: 'dir' }];
    const orphans = findOrphanedLinks({ baseDir, links, sourceDir });
    assert.deepEqual(orphans.map(o => o.rel), ['skills/retired']);
  });

  test('a healthy nested link is never mistaken for an orphan', () => {
    // The dangerous half of the same bug: once the scan recursed, a good link would not
    // match goodDests either, and migrate would delete a live link.
    const nested = path.join(baseDir, 'plugins', 'claude-hud');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'claude_plugins', 'claude-hud'), { recursive: true });
    const src = path.join(sourceDir, 'claude_plugins', 'claude-hud', 'config.json');
    fs.writeFileSync(src, '{}');
    fs.symlinkSync(src, path.join(nested, 'config.json'));

    const links = [{
      src: path.join('claude_plugins', 'claude-hud', 'config.json'),
      dest: path.join('plugins', 'claude-hud', 'config.json'),
      type: 'file',
    }];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('leaves a DANGLING link alone when it is still a current link target', () => {
    // models.json is generated; before the first setup run its link legitimately dangles.
    // check-links re-creates it — migrate must not delete it.
    fs.symlinkSync(path.join(sourceDir, 'models.json'), path.join(baseDir, 'models.json'));
    const links = [{ src: 'models.json', dest: 'models.json', type: 'file' }];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('converts a legacy junction at the skills dir into a real directory', () => {
    // Simulate `~/.codex/skills -> repo/skills` (legacy whole-dir link).
    const repoSkills = path.join(sourceDir, 'skills');
    fs.mkdirSync(path.join(repoSkills, 'migrate'), { recursive: true });
    fs.writeFileSync(path.join(repoSkills, 'migrate', 'SKILL.md'), 'real');
    const codexSkills = path.join(baseDir, 'skills');
    fs.symlinkSync(repoSkills, codexSkills, 'junction');

    ensureRealDir(codexSkills);

    assert.equal(fs.lstatSync(codexSkills).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(codexSkills).isDirectory(), true);
    // Repo skill dir must be untouched (no self-referential clobber).
    assert.equal(fs.readFileSync(path.join(repoSkills, 'migrate', 'SKILL.md'), 'utf8'), 'real');
    assert.equal(fs.lstatSync(path.join(repoSkills, 'migrate')).isSymbolicLink(), false);
  });

  test('ensureRealDir is a no-op when the dir already exists as a real directory', () => {
    const dir = path.join(baseDir, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep'), 'x');
    ensureRealDir(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'keep'), 'utf8'), 'x');
  });

  test('ignores symlinks pointing outside sourceDir', () => {
    const externalDir = path.join(tmpDir, 'external');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'foo.md'), 'foo');
    fs.symlinkSync(path.join(externalDir, 'foo.md'), path.join(baseDir, 'foo.md'));
    const links = [];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });

  test('detects orphans nested inside a current container dir', () => {
    fs.mkdirSync(path.join(baseDir, 'plugins', 'claude-hud'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'claude_plugins', 'claude-hud'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'claude_plugins', 'claude-hud', 'config.json'), '{}');
    fs.writeFileSync(path.join(sourceDir, 'claude_plugins', 'claude-hud', 'old-config.json'), '{}');
    fs.symlinkSync(
      path.join(sourceDir, 'claude_plugins', 'claude-hud', 'config.json'),
      path.join(baseDir, 'plugins', 'claude-hud', 'config.json'),
    );
    fs.symlinkSync(
      path.join(sourceDir, 'claude_plugins', 'claude-hud', 'old-config.json'),
      path.join(baseDir, 'plugins', 'claude-hud', 'old-config.json'),
    );
    const links = [{ src: path.join('claude_plugins', 'claude-hud', 'config.json'), dest: 'plugins/claude-hud/config.json', type: 'file' }];
    const orphans = findOrphanedLinks({ baseDir, links, sourceDir });
    assert.deepEqual(orphans.map(o => o.rel), ['plugins/claude-hud/old-config.json']);
  });

  test('does not descend into real (non-symlink, non-container) directories', () => {
    fs.mkdirSync(path.join(baseDir, 'unrelated'), { recursive: true });
    fs.symlinkSync(path.join(sourceDir, 'OLD.md'), path.join(baseDir, 'unrelated', 'nested.md'));
    const links = [];
    assert.deepEqual(findOrphanedLinks({ baseDir, links, sourceDir }), []);
  });
});

describe('discoverProjectMigrators', () => {
  let tmpDir, ccMarketDir;

  function writeMigration(pluginDir) {
    fs.mkdirSync(path.join(pluginDir, 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'migrations', 'migrate.mjs'),
      'export async function migrate() { return { changed: false, summary: [] }; }',
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cc-'));
    ccMarketDir = path.join(tmpDir, 'cc-market');
    fs.mkdirSync(ccMarketDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty when cc-market dir is missing', () => {
    assert.deepEqual(discoverProjectMigrators(path.join(tmpDir, 'nonexistent')), []);
  });

  test('returns empty when cc-market dir has no plugins with migrations', () => {
    fs.mkdirSync(path.join(ccMarketDir, 'takeover'), { recursive: true });
    assert.deepEqual(discoverProjectMigrators(ccMarketDir), []);
  });

  test('discovers plugins that have a migrations/migrate.mjs', () => {
    writeMigration(path.join(ccMarketDir, 'rem'));
    writeMigration(path.join(ccMarketDir, 'sharp-review'));
    fs.mkdirSync(path.join(ccMarketDir, 'takeover'), { recursive: true });
    const migrators = discoverProjectMigrators(ccMarketDir);
    assert.equal(migrators.length, 2);
    const names = migrators.map(m => m.name).sort();
    assert.deepEqual(names, ['rem', 'sharp-review']);
  });

  test('ignores non-directory entries in cc-market', () => {
    fs.writeFileSync(path.join(ccMarketDir, 'README.md'), 'readme');
    writeMigration(path.join(ccMarketDir, 'rem'));
    const migrators = discoverProjectMigrators(ccMarketDir);
    assert.equal(migrators.length, 1);
    assert.equal(migrators[0].name, 'rem');
  });
});

describe('setup link tables', () => {
  test('skills are linked as a directory for Claude only', () => {
    assert.ok(CLAUDE_LINKS.some((link) => link.src === 'skills' && link.dest === 'skills'));
    assert.ok(!CODEX_LINKS.some((link) => link.src === 'skills' && link.dest === 'skills'));
  });

  test('Codex links project skills inside its own skills directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'skills', 'alpha'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'skills', '.system'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'linked-skill'), { recursive: true });
      fs.symlinkSync(path.join(tmpDir, 'linked-skill'), path.join(tmpDir, 'skills', 'linked'));
      fs.writeFileSync(path.join(tmpDir, 'skills', 'note.md'), 'not a skill');

      assert.deepEqual(discoverCodexSkillLinks(tmpDir).sort((a, b) => a.dest.localeCompare(b.dest)), [
        { src: path.join('skills', 'alpha'), dest: path.join('skills', 'alpha'), type: 'dir' },
        { src: path.join('skills', 'linked'), dest: path.join('skills', 'linked'), type: 'dir' },
      ]);
      assert.ok(getCodexLinks(tmpDir).some(link => link.dest === path.join('skills', 'alpha')));
      assert.ok(getCodexLinks(tmpDir).some(link => link.dest === path.join('skills', 'linked')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('ensureGitignoreTemplate', () => {
  let repoDir;

  // The depth-agnostic template, in canonical order (mirrors CLAUDE_GITIGNORE_TEMPLATE).
  const TEMPLATE = [
    '**/.claude/**',
    '!**/.claude/settings.json',
    '!**/.claude/agents/', '!**/.claude/agents/**',
    '!**/.claude/skills/', '!**/.claude/skills/**',
    '!**/.claude/commands/', '!**/.claude/commands/**',
    '!**/.claude/workflows/', '!**/.claude/workflows/**',
    '!**/.claude/output-styles/', '!**/.claude/output-styles/**',
    '!**/.claude/rules/', '!**/.claude/rules/**',
    '!**/.claude/memory/', '!**/.claude/memory/**',
    '!**/.claude/docs/', '!**/.claude/docs/**',
    '**/.claude/rules/MEMORY.md',
    '**/_meta.json',
  ];

  beforeEach(() => { repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-tmpl-')); });
  afterEach(() => { fs.rmSync(repoDir, { recursive: true, force: true }); });

  const read = () => fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8');

  test('writes the template when no .gitignore exists', () => {
    assert.equal(ensureGitignoreTemplate(repoDir), true);
    assert.ok(read().includes(TEMPLATE.join('\n')));         // contiguous, ordered
  });

  test('is idempotent — no-op when template already present', () => {
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.DS_Store\n' + TEMPLATE.join('\n') + '\n');
    assert.equal(ensureGitignoreTemplate(repoDir), false);
  });

  test('normalizes the broken dir-only form and preserves unrelated lines', () => {
    // Dir-only re-includes under **/.claude/** leave nested files ignored — must be fixed.
    fs.writeFileSync(path.join(repoDir, '.gitignore'),
      '**/.claude/**\n!**/.claude/memory/\nnode_modules/\n**/.claude/rules/MEMORY.md\n**/_meta.json\n');
    assert.equal(ensureGitignoreTemplate(repoDir), true);
    const content = read();
    assert.ok(content.includes('node_modules/'));            // unrelated kept
    assert.ok(content.includes(TEMPLATE.join('\n')));        // full template now present
  });

  test('strips a trailing leak-causing negation (no metadata leak)', () => {
    // Old root-anchored form + a trailing negation that would re-include _meta.json.
    fs.writeFileSync(path.join(repoDir, '.gitignore'),
      '.claude/*\n!.claude/rules/**\n!.claude/memory/**\n');
    assert.equal(ensureGitignoreTemplate(repoDir), true);
    const lines = read().split('\n').map(l => l.trim()).filter(Boolean);
    // **/_meta.json must be last — nothing re-includes after it.
    assert.equal(lines[lines.length - 1], '**/_meta.json');
    assert.equal(read().includes('!.claude/memory/**'), false);
  });

  test('dryRun reports change without writing', () => {
    assert.equal(ensureGitignoreTemplate(repoDir, { dryRun: true }), true);
    assert.equal(fs.existsSync(path.join(repoDir, '.gitignore')), false);
  });
});

describe('migrateGitignore (integration)', () => {
  let repoDir;
  const g = (...a) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' });

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-int-'));
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('commit', '--allow-empty', '-q', '-m', 'init');
  });
  afterEach(() => { fs.rmSync(repoDir, { recursive: true, force: true }); });

  test('overwrite: normalizes broken template then untracks newly-ignored files', () => {
    // Broken dir-only form leaves nested memory files ignored under **/.claude/**.
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '**/.claude/**\n!**/.claude/memory/\n');
    const memDir = path.join(repoDir, '.claude', 'memory', '2026', '01', '01');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'note.md'), 'x');
    g('add', '-A', '-f');                 // force-track despite broken ignore
    g('commit', '-q', '-m', 'add');

    // MEMORY.md is a generated index that SHOULD become untracked.
    const rulesDir = path.join(repoDir, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'MEMORY.md'), 'idx');
    g('add', '-f', '.claude/rules/MEMORY.md');
    g('commit', '-q', '-m', 'idx');

    assert.deepEqual(reposNeedingTemplate(repoDir), ['.']);

    const [res] = migrateGitignore(repoDir, { gitignoreMode: 'overwrite' });
    assert.equal(res.templated, true);
    assert.ok(res.untracked.includes('.claude/rules/MEMORY.md'));
    // The real memory note stays tracked (template re-includes it correctly).
    assert.ok(!res.untracked.includes('.claude/memory/2026/01/01/note.md'));
    const tracked = g('ls-files').toString();
    assert.ok(tracked.includes('.claude/memory/2026/01/01/note.md'));
    assert.ok(!tracked.includes('.claude/rules/MEMORY.md'));
  });

  test('skip: leaves .gitignore untouched, untracks only per existing rules', () => {
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '**/.claude/**\n!**/.claude/memory/\n');
    g('add', '-A'); g('commit', '-q', '-m', 'gi');
    const before = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8');

    const [res] = migrateGitignore(repoDir, { gitignoreMode: 'skip' });
    assert.equal(res.templated, false);
    assert.equal(res.wouldTemplate, true);   // still reports it differs
    assert.equal(fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8'), before);
  });
});

describe('resolveAliasBinDirs', () => {
  const sep = path.sep;

  test('prefers the claude bin dir for both target and claude when claude exists', () => {
    const locate = (cmd) => (cmd === 'claude' ? `${sep}opt${sep}claude${sep}bin` : `${sep}opt${sep}codex${sep}bin`);
    const { claudeBin, codexBin, targetBin } = resolveAliasBinDirs(locate);
    assert.equal(claudeBin, `${sep}opt${sep}claude${sep}bin`);
    assert.equal(codexBin, `${sep}opt${sep}codex${sep}bin`);
    assert.equal(targetBin, `${sep}opt${sep}claude${sep}bin`);
  });

  test('falls back to codex bin dir when only codex is installed', () => {
    const locate = (cmd) => (cmd === 'codex' ? `${sep}opt${sep}codex${sep}bin` : null);
    const { claudeBin, codexBin, targetBin } = resolveAliasBinDirs(locate);
    assert.equal(claudeBin, null);
    assert.equal(codexBin, `${sep}opt${sep}codex${sep}bin`);
    assert.equal(targetBin, `${sep}opt${sep}codex${sep}bin`);
  });

  test('returns null target when neither host is installed', () => {
    const { claudeBin, codexBin, targetBin } = resolveAliasBinDirs(() => null);
    assert.equal(claudeBin, null);
    assert.equal(codexBin, null);
    assert.equal(targetBin, null);
  });
});

describe('locateBinDir', () => {
  test('returns the dirname of the first matched path', () => {
    const run = () => `${path.sep}usr${path.sep}local${path.sep}bin${path.sep}codex\n${path.sep}other${path.sep}codex`;
    assert.equal(locateBinDir('codex', run), `${path.sep}usr${path.sep}local${path.sep}bin`);
  });

  test('returns null when the locator throws (command not found)', () => {
    const run = () => { throw new Error('not found'); };
    assert.equal(locateBinDir('nope', run), null);
  });
});

describe('migrateRetiredPlugins', () => {
  let tmpDir, settingsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-test-'));
    settingsPath = path.join(tmpDir, 'claude_settings.json');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const write = (obj) => fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  test('retires takeover → fabric: swaps enabledPlugins + permission entries', () => {
    write({
      permissions: { allow: ['Bash(ls)', 'Skill(takeover:continue)', 'mcp__plugin_takeover_takeover__call_model', 'Skill(rem:rem)'] },
      enabledPlugins: { 'takeover@cc-market': true, 'rem@cc-market': true },
    });
    const retired = migrateRetiredPlugins({ settingsPath });
    assert.deepEqual(retired, ['takeover@cc-market']);
    const s = read();
    assert.ok(!('takeover@cc-market' in s.enabledPlugins), 'takeover entry removed');
    assert.equal(s.enabledPlugins['fabric@cc-market'], true, 'fabric enabled');
    assert.equal(s.enabledPlugins['rem@cc-market'], true, 'unrelated plugin untouched');
    // stale takeover perms gone; unrelated perms kept; fabric perms transferred
    assert.ok(!s.permissions.allow.some(p => p.includes('takeover')), 'no takeover perms remain');
    assert.ok(s.permissions.allow.includes('Bash(ls)') && s.permissions.allow.includes('Skill(rem:rem)'));
    assert.ok(s.permissions.allow.includes('mcp__plugin_fabric_fabric__call'), 'fabric call perm added');
    assert.ok(s.permissions.allow.includes('Skill(fabric:continue)'));
  });

  test('idempotent: no-op when already migrated', () => {
    write({ permissions: { allow: ['mcp__plugin_fabric_fabric__call'] }, enabledPlugins: { 'fabric@cc-market': true } });
    const before = read();
    assert.deepEqual(migrateRetiredPlugins({ settingsPath }), []);
    assert.deepEqual(read(), before, 'file unchanged');
  });

  test('dry-run reports without writing', () => {
    write({ enabledPlugins: { 'takeover@cc-market': true } });
    const before = fs.readFileSync(settingsPath, 'utf8');
    const retired = migrateRetiredPlugins({ settingsPath, dryRun: true });
    assert.deepEqual(retired, ['takeover@cc-market']);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'not written in dry-run');
  });

  test('does not add fabric to enabledPlugins if user had disabled it', () => {
    // Only a stale permission lingers; no enabledPlugins entry for takeover.
    write({ permissions: { allow: ['Skill(takeover:models)'] }, enabledPlugins: { 'fabric@cc-market': false } });
    migrateRetiredPlugins({ settingsPath });
    const s = read();
    assert.equal(s.enabledPlugins['fabric@cc-market'], false, 'user disable preserved');
    assert.ok(!s.permissions.allow.some(p => p.includes('takeover')));
  });

  test('missing settings file is a no-op', () => {
    assert.deepEqual(migrateRetiredPlugins({ settingsPath: path.join(tmpDir, 'nope.json') }), []);
  });
});
