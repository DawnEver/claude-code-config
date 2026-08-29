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
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { sourceDir, claudeDir, codexDir, CLAUDE_LINKS, getCodexLinks, KNOWN_ALIAS_NAMES, removeExisting, setup, getSyncDir } from '../../scripts/setup/setup.js';
import {
  findGitRepos,
  ensureGitignoreTemplate,
  untrackIgnored,
  findNestedClaudeIgnores,
  migrateGitignore,
  reposNeedingTemplate,
  promptGitignoreMode,
} from './gitignore-hygiene.js';

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
        try {
          target = fs.realpathSync(full);
        } catch {
          // Dangling link: the target is gone. Before the sync-dir split every link
          // pointed into the repo, so an unresolvable one was unreachable in practice.
          // Now a link can point at a payload dir or an old repo location that has since
          // been deleted, and skipping it here made those permanently uncleanable.
          // Entries still in goodDests are left alone — check-links re-creates those.
          if (!goodDests.has(rel)) orphans.push({ rel, full, dangling: true });
          continue;
        }
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
    { baseDir: codexDir, links: getCodexLinks(), label: 'Codex' },
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
    const raw = execFileSync(isWindows ? 'where' : 'which', ['claude'], { stdio: 'pipe' })
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

// ── C. Gitignore hygiene ──
// Extracted to gitignore-hygiene.js. Re-exported for backward compatibility.
export {
  findGitRepos,
  ensureGitignoreTemplate,
  untrackIgnored,
  findNestedClaudeIgnores,
  migrateGitignore,
  reposNeedingTemplate,
  promptGitignoreMode,
} from './gitignore-hygiene.js';

// ── E. Retired-plugin settings migration ──
// Plugins merged or removed over time leave stale entries in claude_settings.json — both an
// `enabledPlugins` key and permission-allow entries for their skills/MCP tools. Remove them
// (idempotent, self-detecting) and ensure the replacement is enabled. `settingsPath` is the
// repo's claude_settings.json, which is symlinked into ~/.claude.
export const RETIRED_PLUGINS = [
  {
    id: 'takeover@cc-market',
    replacement: 'fabric@cc-market',        // merged into fabric (one `call` primitive)
    permPrefixes: ['Skill(takeover:', 'mcp__plugin_takeover_takeover__'],
    // Trust the user already granted the retired plugin, transferred to the replacement so
    // its skills/tools don't re-prompt. Added only when a stale entry was actually present.
    addPerms: [
      'Skill(fabric:continue)', 'Skill(fabric:models)', 'Skill(fabric:summary)',
      'mcp__plugin_fabric_fabric__call', 'mcp__plugin_fabric_fabric__list_providers',
    ],
  },
];

// claude_settings.json lives in the sync payload, which is usually NOT the repo dir.
// Resolving it against sourceDir made this a permanent silent no-op that still reported
// "no retired plugin entries" — an actively false result. Default to the resolved sync dir.
export function migrateRetiredPlugins({ dryRun, settingsPath = path.join(getSyncDir(), 'claude_settings.json') } = {}) {
  if (!fs.existsSync(settingsPath)) {
    console.log(`SKIP  retired-plugin migration - claude_settings.json not found at ${settingsPath}`);
    return [];
  }
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return []; }

  const retired = [];
  let changed = false;
  const enabled = settings.enabledPlugins || (settings.enabledPlugins = {});
  const allow = settings.permissions?.allow;

  for (const { id, replacement, permPrefixes = [], addPerms = [] } of RETIRED_PLUGINS) {
    const hasEntry = id in enabled;
    const stalePerms = Array.isArray(allow) && allow.some(p => permPrefixes.some(pre => p.startsWith(pre)));
    if (!hasEntry && !stalePerms) continue;

    if (dryRun) {
      console.log(`WOULD RETIRE  ${id}${replacement ? ` → ${replacement}` : ''} in claude_settings.json`);
    } else {
      if (hasEntry) delete enabled[id];
      if (replacement && !(replacement in enabled)) enabled[replacement] = true;
      if (Array.isArray(allow)) {
        const kept = allow.filter(p => !permPrefixes.some(pre => p.startsWith(pre)));
        for (const p of addPerms) if (!kept.includes(p)) kept.push(p);
        settings.permissions.allow = kept;
      }
      changed = true;
      console.log(`RETIRE  ${id}${replacement ? ` → ${replacement}` : ''} - swapped stale settings entries`);
    }
    retired.push(id);
  }

  if (changed && !dryRun) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return retired;
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

  console.log('\n--- Retired plugins ---');
  const retired = migrateRetiredPlugins({ dryRun });
  if (retired.length === 0) console.log('OK    no retired plugin entries in claude_settings.json');

  if (!dryRun) {
    console.log('\n--- Re-link & re-alias (current layout) ---');
    setup();
  }

  console.log('\n--- Gitignore hygiene ---');
  const cwd = process.cwd();
  const isGitRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
  if (!isGitRepo(cwd)) {
    console.log('NOTE  not a git repo — skipping');
  } else {
    const giArg = (args.find(a => a.startsWith('--gitignore=')) || '').split('=')[1];
    const pending = reposNeedingTemplate(cwd);
    let mode = ['overwrite', 'skip', 'ai'].includes(giArg) ? giArg : null;
    if (!mode) mode = (!dryRun && pending.length) ? await promptGitignoreMode(pending) : 'overwrite';

    if (mode === 'ai' && pending.length) {
      console.log('AI-EDIT REQUIRED — perform these merges now, do not stop after this run:');
      console.log('  Template block to splice into each .gitignore (one contiguous group):');
      const template = [
        '**/.claude/**',
        '!**/.claude/settings.json',
        '!**/.claude/agents/', '!**/.claude/agents/**',
        '!**/.claude/skills/', '!**/.claude/skills/**',
        '!**/.claude/commands/', '!**/.claude/commands/**',
        '!**/.claude/workflows/', '!**/.claude/workflows/**',
        '!**/.claude/output-styles/', '!**/.claude/output-styles/**',
        '!**/.claude/rules/', '!**/.claude/rules/**',
        '!**/.claude/memory/', '!**/.claude/memory/**',
        '**/.claude/rules/MEMORY.md', '**/_meta.json',
      ];
      for (const l of template) console.log(`    ${l}`);
      console.log('  Target files (merge template above with each repo\'s own rules, drop superseded managed lines):');
      for (const r of pending) console.log(`    - ${path.join(cwd, r, '.gitignore')}`);
      console.log('  After merging, run `git rm --cached` on any now-ignored tracked files in those repos.');
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
