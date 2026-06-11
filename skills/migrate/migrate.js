#!/usr/bin/env node
// Bring this repo's ~/.claude & ~/.codex symlinks, and the current project's
// .claude/ (cc-market plugin files), up to date.
//
// "Migrate to latest" only — no version-range bookkeeping. Each step is
// idempotent and self-detecting: a no-op if everything is already current.
//
//   A. Repo links — remove symlinks into this repo that no longer correspond
//      to an entry in CLAUDE_LINKS/CODEX_LINKS (renamed/removed over time),
//      then re-run the normal link-creation pass.
//   B. cc-market projects — for every cc-market plugin that has a
//      migrations/migrate.mjs, run it against the current project.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';
import { sourceDir, claudeDir, codexDir, CLAUDE_LINKS, CODEX_LINKS, KNOWN_ALIAS_NAMES, removeExisting, setup } from '../../scripts/setup/setup.js';

// ── A. Repo link migration ──

export function findOrphanedLinks({ baseDir, links, sourceDir }) {
  if (!fs.existsSync(baseDir)) return [];

  const goodDests = new Set(links.map(l => l.dest));
  // All proper prefixes of every dest (e.g. 'plugins', 'plugins/claude-hud' for
  // 'plugins/claude-hud/config.json') — directories worth recursing into.
  const containerPrefixes = new Set();
  for (const dest of goodDests) {
    const parts = dest.split('/');
    for (let i = 1; i < parts.length; i++) containerPrefixes.add(parts.slice(0, i).join('/'));
  }

  let sourceResolved;
  try { sourceResolved = fs.realpathSync(path.resolve(sourceDir)); } catch { sourceResolved = path.resolve(sourceDir); }
  const orphans = [];

  function scan(dir, relPrefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }

      if (stat.isSymbolicLink()) {
        let target;
        try { target = fs.realpathSync(full); } catch { continue; }
        if (target !== sourceResolved && !target.startsWith(sourceResolved + path.sep)) continue;
        if (!goodDests.has(rel)) orphans.push({ rel, full });
      } else if (stat.isDirectory() && containerPrefixes.has(rel)) {
        scan(full, rel);
      }
    }
  }

  scan(baseDir, '');
  return orphans;
}

export function migrateRepoLinks({ dryRun } = {}) {
  const removed = [];
  for (const { baseDir, links, label } of [
    { baseDir: claudeDir, links: CLAUDE_LINKS, label: 'Claude' },
    { baseDir: codexDir, links: CODEX_LINKS, label: 'Codex' },
  ]) {
    for (const { rel, full } of findOrphanedLinks({ baseDir, links, sourceDir })) {
      if (dryRun) {
        console.log(`WOULD REMOVE  ${label}/${rel} - orphaned link into ${sourceDir}`);
      } else {
        removeExisting(full);
        console.log(`REMV  ${label}/${rel} - orphaned link into ${sourceDir}`);
      }
      removed.push(`${label}/${rel}`);
    }
  }
  return removed;
}

// ── B. Orphaned CLI alias cleanup ──

const MARKER = '# claude-code-alias';

function findClaudeBin() {
  const isWindows = os.platform() === 'win32';
  try {
    const raw = execSync(isWindows ? 'where claude' : 'which claude', { stdio: 'pipe' })
      .toString().trim().split(/\r?\n/)[0].trim();
    return path.dirname(raw);
  } catch { return null; }
}

export function migrateOrphanedAliases({ dryRun } = {}) {
  const claudeBin = findClaudeBin();
  if (!claudeBin || !fs.existsSync(claudeBin)) return [];

  const known = new Set(KNOWN_ALIAS_NAMES);
  const removed = [];

  let entries;
  try { entries = fs.readdirSync(claudeBin, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(claudeBin, entry.name);
    // Check if it's one of our managed alias files (has the marker)
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!content.includes(MARKER)) continue;

    // Extract the base name (strip .cmd extension on Windows)
    const baseName = entry.name.endsWith('.cmd') ? entry.name.slice(0, -4) : entry.name;
    if (known.has(baseName)) continue;

    if (dryRun) {
      console.log(`WOULD REMOVE  alias ${entry.name} - orphaned (no longer in KNOWN_ALIAS_NAMES)`);
    } else {
      fs.unlinkSync(full);
      console.log(`REMV  alias ${entry.name} - orphaned (no longer in KNOWN_ALIAS_NAMES)`);
    }
    removed.push(entry.name);
  }

  return removed;
}

// ── C. Gitignore hygiene (normalize .claude template, untrack now-ignored, drop nested ignores) ──
//
// This skill is the single owner of the .claude/ gitignore template. It normalizes
// every scanned repo's .gitignore to CLAUDE_GITIGNORE_TEMPLATE, then untracks (keep
// on disk) anything the refreshed rules now ignore, and deletes stray .gitignore
// files inside a .claude/ tree (the repo-root .gitignore is the sole source of truth).
//
// The template is depth-agnostic so it works whether .claude sits at the repo root or
// nested (monorepo / plugin dirs). Each content dir needs BOTH a `/` (so git descends)
// and a `/**` (so the files come back) negation — `**/.claude/**` re-matches every
// nested file, so a dir-only negation alone leaves them ignored. The two generated
// artifacts rem owns (MEMORY.md index, _meta.json) come LAST so they win and stay
// ignored. Verify changes with `git add --dry-run` on a fresh nested file, NOT
// `check-ignore -v` (whose exit code misreports negated re-includes).
const CLAUDE_GITIGNORE_TEMPLATE = [
  '**/.claude/**',
  '!**/.claude/settings.json',
  '!**/.claude/agents/',
  '!**/.claude/agents/**',
  '!**/.claude/skills/',
  '!**/.claude/skills/**',
  '!**/.claude/commands/',
  '!**/.claude/commands/**',
  '!**/.claude/workflows/',
  '!**/.claude/workflows/**',
  '!**/.claude/rules/',
  '!**/.claude/rules/**',
  '!**/.claude/memory/',
  '!**/.claude/memory/**',
  '**/.claude/rules/MEMORY.md',
  '**/_meta.json',
];

// Lines this skill owns and may reposition — the template plus superseded variants
// (root-anchored and dir-only forms). Stripped wherever they sit before the template
// is re-appended, so a straggler (e.g. a trailing `!.claude/memory/**`) can't reorder
// after `**/_meta.json` and leak the metadata.
const MANAGED_GITIGNORE_LINES = new Set([
  ...CLAUDE_GITIGNORE_TEMPLATE,
  '.claude/*', '!.claude/rules/**', '!.claude/memory/**', '.claude/rules/MEMORY.md',
  '!.claude/settings.json', '!.claude/agents/', '!.claude/skills/',
  '!.claude/commands/', '!.claude/workflows/', '!.claude/rules/', '!.claude/memory/',
]);

const REPO_SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function git(repoDir, argStr) {
  return execSync(`git ${argStr}`, { cwd: repoDir, stdio: 'pipe' }).toString();
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

// cwd repo (if any) plus every nested git repo beneath it.
export function findGitRepos(root, { maxDepth = 4 } = {}) {
  const repos = [];
  if (isGitRepo(root)) repos.push(root);
  (function walk(dir, depth) {
    if (depth >= maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || REPO_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (isGitRepo(full)) repos.push(full);
      walk(full, depth + 1);
    }
  })(root, 0);
  return repos;
}

// Normalize repoDir/.gitignore to CLAUDE_GITIGNORE_TEMPLATE as one contiguous block.
// No-op when the block is already present verbatim with no managed line outside it.
export function ensureGitignoreTemplate(repoDir, { dryRun } = {}) {
  const gitignorePath = path.join(repoDir, '.gitignore');
  const original = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const trimmed = original.split(/\r?\n/).map(l => l.trim());

  const hasBlock = trimmed.join('\n').includes(CLAUDE_GITIGNORE_TEMPLATE.join('\n'));
  const managedCount = trimmed.filter(l => MANAGED_GITIGNORE_LINES.has(l)).length;
  if (hasBlock && managedCount === CLAUDE_GITIGNORE_TEMPLATE.length) return false;

  const kept = original.split(/\r?\n/).filter(l => !MANAGED_GITIGNORE_LINES.has(l.trim()));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const next = [...kept, ...(kept.length ? [''] : []), ...CLAUDE_GITIGNORE_TEMPLATE, ''].join('\n');
  if (next === original) return false;
  if (!dryRun) fs.writeFileSync(gitignorePath, next);
  return true;
}

// Files tracked by `repoDir` that its own .gitignore now excludes.
export function untrackIgnored(repoDir, { dryRun } = {}) {
  let out;
  try { out = git(repoDir, 'ls-files --cached --ignored --exclude-standard'); }
  catch { return []; }
  const files = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!files.length || dryRun) return files;
  // execFileSync with an arg array — no shell, so paths with spaces/quotes are safe.
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    execFileSync('git', ['rm', '--cached', '--quiet', '--', ...chunk], { cwd: repoDir, stdio: 'pipe' });
  }
  return files;
}

// .gitignore files nested inside a .claude/ tree (shadow the repo-root template).
// Does not descend into nested git repos — those are scanned as their own repo.
export function findNestedClaudeIgnores(repoDir) {
  const found = [];
  (function walk(dir, insideClaude) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (REPO_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (dir !== repoDir && isGitRepo(full)) continue; // leave sub-repos to their own pass
        walk(full, insideClaude || e.name === '.claude');
      } else if (insideClaude && e.name === '.gitignore') {
        found.push(full);
      }
    }
  })(repoDir, false);
  return found;
}

// gitignoreMode: 'overwrite' normalizes .gitignore to the template; 'skip' leaves it
// untouched (only untracks per the repo's existing rules + drops nested ignores).
export function migrateGitignore(root, { dryRun, gitignoreMode = 'overwrite' } = {}) {
  const results = [];
  for (const repoDir of findGitRepos(root)) {
    const wouldTemplate = ensureGitignoreTemplate(repoDir, { dryRun: true });
    const templated = gitignoreMode === 'overwrite'
      ? ensureGitignoreTemplate(repoDir, { dryRun })
      : false;
    const untracked = untrackIgnored(repoDir, { dryRun });
    const ignores = findNestedClaudeIgnores(repoDir);
    if (!dryRun) for (const f of ignores) { try { fs.unlinkSync(f); } catch {} }
    results.push({ repo: path.relative(root, repoDir) || '.', wouldTemplate, templated, untracked, ignores });
  }
  return results;
}

// Which scanned repos would have their .gitignore template rewritten.
export function reposNeedingTemplate(root) {
  return findGitRepos(root).filter(r => ensureGitignoreTemplate(r, { dryRun: true }))
    .map(r => path.relative(root, r) || '.');
}

// Interactive confirmation (only when stdin is a TTY). Returns 'overwrite' | 'ai' | 'skip'.
async function promptGitignoreMode(repoLabels) {
  if (!process.stdin.isTTY) return 'overwrite';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const list = repoLabels.map(r => `      - ${r}/.gitignore`).join('\n');
  const answer = await new Promise(res => rl.question(
    `\n${repoLabels.length} repo(s) differ from the .claude gitignore template:\n${list}\n` +
    `  [O]verwrite (default) / [A]I edit (skip writing, leave for manual fix) / [S]kip: `, res));
  rl.close();
  const c = answer.trim().toLowerCase();
  if (c === 's' || c === 'skip') return 'skip';
  if (c === 'a' || c === 'ai') return 'ai';
  return 'overwrite';
}

// ── D. cc-market project migration ──

export function discoverProjectMigrators(ccMarketDir) {
  const dir = ccMarketDir || path.join(sourceDir, 'cc-market');
  if (!fs.existsSync(dir)) return [];

  const migrators = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const migratePath = path.join(dir, entry.name, 'migrations', 'migrate.mjs');
    if (fs.existsSync(migratePath)) migrators.push({ name: entry.name, migratePath });
  }
  return migrators;
}

export async function migrateProject(cwd) {
  const results = [];
  for (const { name, migratePath } of discoverProjectMigrators()) {
    const mod = await import(pathToFileURL(migratePath).href);
    if (typeof mod.migrate !== 'function') continue;
    const { changed, summary } = await mod.migrate(cwd);
    results.push({ plugin: name, changed, summary: summary || [] });
  }
  return results;
}

// ── CLI ──

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('--- Repo links ---');
  const removed = migrateRepoLinks({ dryRun });
  if (removed.length === 0) console.log('OK    no orphaned links');

  console.log('\n--- CLI aliases ---');
  const aliasRemoved = migrateOrphanedAliases({ dryRun });
  if (aliasRemoved.length === 0) console.log('OK    no orphaned CLI aliases');

  if (!dryRun) {
    console.log('\n--- Re-link & re-alias (current layout) ---');
    setup();
  }

  console.log('\n--- Gitignore hygiene ---');
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    console.log('NOTE  not a git repo — skipping');
  } else {
    // Mode resolution: explicit --gitignore=<overwrite|skip|ai> wins; else, when a TTY
    // and a repo would change, confirm interactively (default overwrite); else overwrite.
    const giArg = (args.find(a => a.startsWith('--gitignore=')) || '').split('=')[1];
    const pending = reposNeedingTemplate(cwd);
    let mode = ['overwrite', 'skip', 'ai'].includes(giArg) ? giArg : null;
    if (!mode) mode = (!dryRun && pending.length) ? await promptGitignoreMode(pending) : 'overwrite';

    if (mode === 'ai' && pending.length) {
      console.log('NOTE  AI-edit chosen — .gitignore left untouched in:');
      for (const r of pending) console.log(`        - ${r}/.gitignore`);
      console.log('      Apply CLAUDE_GITIGNORE_TEMPLATE by hand, merging each repo\'s own rules.');
    }
    const gitignoreMode = mode === 'overwrite' ? 'overwrite' : 'skip';

    let any = false;
    for (const { repo, templated, untracked, ignores } of migrateGitignore(cwd, { dryRun, gitignoreMode })) {
      if (templated) { any = true; console.log(`${dryRun ? 'WOULD GI   ' : 'GI    '}${repo}/.gitignore - normalized .claude template`); }
      for (const f of untracked) { any = true; console.log(`${dryRun ? 'WOULD RM   ' : 'RM    '}${repo}/${f} - tracked but ignored`); }
      for (const f of ignores) { any = true; console.log(`${dryRun ? 'WOULD DEL  ' : 'DEL   '}${path.relative(cwd, f)} - nested .gitignore inside .claude/`); }
    }
    if (!any) console.log('OK    .gitignore templates current, no tracked-but-ignored files or nested ignores');
  }

  console.log('\n--- Project (.claude/) ---');
  if (!fs.existsSync(path.join(cwd, '.claude'))) {
    console.log('NOTE  no .claude/ directory in current project — nothing to migrate');
  } else if (dryRun) {
    const migrators = discoverProjectMigrators();
    if (migrators.length === 0) {
      console.log('SKIP  no cc-market plugin migrations found');
    } else {
      console.log('SKIP  --dry-run would migrate these plugins:');
      for (const { name } of migrators) console.log(`        - ${name}`);
    }
  } else {
    const results = await migrateProject(cwd);
    if (results.length === 0) {
      console.log('OK    no cc-market plugins with migrations');
    } else {
      let any = false;
      for (const { plugin, changed, summary } of results) {
        if (!changed) {
          console.log(`OK    ${plugin} - already up to date`);
          continue;
        }
        any = true;
        console.log(`OK    ${plugin}:`);
        for (const line of summary) console.log(`        - ${line}`);
      }
      if (!any) console.log('OK    everything up to date');
    }
  }
}

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const selfPath = path.resolve(skillDir, 'migrate.js');
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isDirectInvocation = invokedPath === selfPath;
if (!isDirectInvocation) {
  try { isDirectInvocation = fs.realpathSync(invokedPath) === fs.realpathSync(selfPath); } catch {}
}
if (isDirectInvocation) {
  main();
}
