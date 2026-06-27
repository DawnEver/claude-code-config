// Gitignore hygiene — normalize .gitignore with the .claude template,
// clean nested ignores, and untrack now-ignored files.
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execFileSync } from 'child_process';

const REPO_SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

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
  '!**/.claude/output-styles/',
  '!**/.claude/output-styles/**',
  '!**/.claude/rules/',
  '!**/.claude/rules/**',
  '!**/.claude/memory/',
  '!**/.claude/memory/**',
  '**/.claude/rules/MEMORY.md',
  '**/_meta.json',
];

// Lines this module owns and may reposition — the template plus superseded variants
// (root-anchored and dir-only forms). Stripped wherever they sit before the template
// is re-appended, so a straggler (e.g. a trailing `!.claude/memory/**`) can't reorder
// after `**/_meta.json` and leak the metadata.
const MANAGED_GITIGNORE_LINES = new Set([
  ...CLAUDE_GITIGNORE_TEMPLATE,
  '.claude/*', '!.claude/rules/**', '!.claude/memory/**', '.claude/rules/MEMORY.md',
  '!.claude/settings.json', '!.claude/agents/', '!.claude/skills/',
  '!.claude/commands/', '!.claude/workflows/', '!.claude/rules/', '!.claude/memory/',
  '!.claude/output-styles/', '!.claude/output-styles/**',
]);

function git(repoDir, ...args) {
  return execFileSync('git', args, { cwd: repoDir, stdio: 'pipe', windowsHide: true }).toString();
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
  try { out = git(repoDir, 'ls-files', '--cached', '--ignored', '--exclude-standard'); }
  catch { return []; }
  const files = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!files.length || dryRun) return files;
  // execFileSync with an arg array — no shell, so paths with spaces/quotes are safe.
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    execFileSync('git', ['rm', '--cached', '--quiet', '--', ...chunk], { cwd: repoDir, stdio: 'pipe', windowsHide: true });
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
export async function promptGitignoreMode(repoLabels) {
  if (!process.stdin.isTTY) return 'overwrite';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const list = repoLabels.map(r => `      - ${r}/.gitignore`).join('\n');
  const prompt = `\n${repoLabels.length} repo(s) differ from the .claude gitignore template:\n${list}\n` +
    `  [O]verwrite (default) / [A]I edit (skip writing, leave for manual fix) / [S]kip: `;
  const answer = await Promise.race([
    new Promise(res => rl.question(prompt, res)),
    // Timeout after 30s (e.g. SSH without PTY): default to overwrite
    new Promise(res => setTimeout(() => { rl.write('o'); res('o'); }, 30_000)),
  ]);
  rl.close();
  const c = answer.trim().toLowerCase();
  if (c === 's' || c === 'skip') return 'skip';
  if (c === 'a' || c === 'ai') return 'ai';
  return 'overwrite';
}
