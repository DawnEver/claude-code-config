import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CLAUDE_LINKS, CODEX_LINKS, discoverCodexSkillLinks, getCodexLinks } from '../../scripts/setup/setup.js';
import { findOrphanedLinks, discoverProjectMigrators, ensureGitignoreTemplate, migrateGitignore, reposNeedingTemplate } from './migrate.js';

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
