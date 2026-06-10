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
import { execSync } from 'child_process';
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

// ── C. cc-market project migration ──

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

  console.log('\n--- Project (.claude/) ---');
  const cwd = process.cwd();
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
