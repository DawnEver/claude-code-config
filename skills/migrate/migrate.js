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
//   B. cc-market projects — for every installed cc-market plugin relevant to
//      the current directory, run its migrations/migrate.mjs (if it has one).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { sourceDir, claudeDir, codexDir, CLAUDE_LINKS, CODEX_LINKS, removeExisting, setup } from '../../scripts/setup/setup.js';

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

// ── B. cc-market project migration ──

export function discoverProjectMigrators(cwd) {
  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) return [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  } catch {
    return [];
  }

  const cwdResolved = path.resolve(cwd);
  const migrators = [];
  for (const [key, entries] of Object.entries(data.plugins || {})) {
    if (!key.endsWith('@cc-market')) continue;
    const name = key.split('@')[0];
    for (const entry of entries || []) {
      const relevant = entry.scope === 'user'
        || (entry.scope === 'project' && entry.projectPath && path.resolve(entry.projectPath) === cwdResolved);
      if (!relevant || !entry.installPath) continue;

      const migratePath = path.join(entry.installPath, 'migrations', 'migrate.mjs');
      if (fs.existsSync(migratePath)) migrators.push({ name, migratePath });
    }
  }
  return migrators;
}

export async function migrateProject(cwd) {
  const results = [];
  for (const { name, migratePath } of discoverProjectMigrators(cwd)) {
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

  if (!dryRun) {
    console.log('\n--- Re-link (current layout) ---');
    setup();
  }

  console.log('\n--- Project (.claude/) ---');
  const cwd = process.cwd();
  const results = dryRun ? [] : await migrateProject(cwd);
  if (dryRun) {
    console.log('SKIP  --dry-run does not run plugin migrations (they are write-only and self-detecting)');
  } else if (results.length === 0) {
    console.log('OK    no cc-market plugins with migrations installed for this project');
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

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
if (path.resolve(process.argv[1] || '') === path.resolve(skillDir, 'migrate.js')) {
  main();
}
