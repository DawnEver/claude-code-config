#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { fixLspWindows } from './fix-lsp-windows.js';
import { checkMacNotify } from './check-mac-notify.js';
import { installShellAliases } from './install-shell-aliases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const sourceDir = path.resolve(__dirname, '../..');
export const claudeDir = path.join(os.homedir(), '.claude');
export const codexDir = path.join(os.homedir(), '.codex');

export const KNOWN_ALIAS_NAMES = ['cco', 'ccds', 'todo', 'traceme'];

export const CLAUDE_LINKS = [
  { src: 'GLOBAL-AGENTS.md', dest: 'CLAUDE.md', type: 'file' },
  { src: 'claude_settings.json', dest: 'settings.json', type: 'file' },
  { src: path.join('claude_plugins', 'claude-hud', 'config.json'), dest: path.join('plugins', 'claude-hud', 'config.json'), type: 'file' },
  { src: 'skills', dest: 'skills', type: 'dir' },
  { src: 'output-styles', dest: 'output-styles', type: 'dir' },
  { src: 'agents', dest: 'agents', type: 'dir' },
  { src: 'scripts', dest: 'scripts', type: 'dir' },
  { src: '.claude/workflows', dest: 'workflows', type: 'dir' },
  { src: 'claude_env_settings.json', dest: 'claude_env_settings.json', type: 'file' },
  { src: 'keybindings.json', dest: 'keybindings.json', type: 'file' },
];

export const CODEX_LINKS = [
  { src: 'codex_config.toml', dest: 'config.toml', type: 'file' },
  // Codex's global instructions file is $CODEX_HOME/AGENTS.md (mirrors ~/.claude/CLAUDE.md
  // for Claude). Same single source — GLOBAL-AGENTS.md — linked to both hosts.
  { src: 'GLOBAL-AGENTS.md', dest: 'AGENTS.md', type: 'file' },
];

const isWindows = process.platform === 'win32';

export function discoverCodexSkillLinks(baseSourceDir = sourceDir) {
  const skillsDir = path.join(baseSourceDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => {
      if (entry.name.startsWith('.')) return false;
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;

      try {
        return fs.statSync(path.join(skillsDir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map(entry => ({
      src: path.join('skills', entry.name),
      dest: path.join('skills', entry.name),
      type: 'dir',
    }));
}

export function getCodexLinks(baseSourceDir = sourceDir) {
  return [...CODEX_LINKS, ...discoverCodexSkillLinks(baseSourceDir)];
}

// Legacy installs linked the whole skills dir (`~/.codex/skills -> repo/skills`).
// We now link skills individually, but if the directory is still a junction, the
// per-skill link destinations resolve *through* it back into the repo, producing
// self-referential junctions inside repo/skills. Convert the legacy link to a
// real directory first so per-skill links land in ~/.codex, not the repo.
export function ensureRealDir(dirPath) {
  const stat = fs.lstatSync(dirPath, { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) {
    fs.unlinkSync(dirPath);
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

export function removeExisting(destPath) {
  const stat = fs.lstatSync(destPath, { throwIfNoEntry: false });
  if (!stat) return false;

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(destPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(destPath);
  }
  return true;
}

export function setup() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace') || args.includes('-r');

  console.log(`Source: ${sourceDir}`);
  console.log(`Claude target: ${claudeDir}`);
  console.log(`Codex target: ${codexDir}`);
  if (replace) console.log('Mode: replace existing files/dirs\n');
  else console.log('');

  // Ensure claude_settings.json exists (copy from template if not)
  const settingsPath = path.join(sourceDir, 'claude_settings.json');
  const settingsTemplatePath = path.join(sourceDir, 'claude_settings.template.json');
  if (!fs.existsSync(settingsPath) && fs.existsSync(settingsTemplatePath)) {
    fs.copyFileSync(settingsTemplatePath, settingsPath);
    console.log('COPY  claude_settings.template.json - claude_settings.json');
  }

  // Ensure codex_config.toml exists (copy from template if not)
  const codexConfigPath = path.join(sourceDir, 'codex_config.toml');
  const codexConfigTemplatePath = path.join(sourceDir, 'codex_config.template.toml');
  if (!fs.existsSync(codexConfigPath) && fs.existsSync(codexConfigTemplatePath)) {
    fs.copyFileSync(codexConfigTemplatePath, codexConfigPath);
    console.log('COPY  codex_config.template.toml - codex_config.toml');
  }

  // Ensure claude_env_settings.json exists (copy from template if not)
  const envSettingsPath = path.join(sourceDir, 'claude_env_settings.json');
  const envSettingsTemplatePath = path.join(sourceDir, 'claude_env_settings.template.json');
  if (!fs.existsSync(envSettingsPath) && fs.existsSync(envSettingsTemplatePath)) {
    fs.copyFileSync(envSettingsTemplatePath, envSettingsPath);
    console.log('COPY  claude_env_settings.template.json - claude_env_settings.json');
  }

  let created = 0, skipped = 0, errors = 0;

  // Process Claude links
  console.log('--- Claude ---');
  for (const link of CLAUDE_LINKS) {
    const srcPath = path.join(sourceDir, link.src);
    const baseDir = claudeDir;
    const destPath = path.join(baseDir, link.dest);

    if (!fs.existsSync(srcPath)) {
      console.log(`SKIP  ${link.dest} - source not found: ${srcPath}`);
      skipped++;
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    try {
      const stat = fs.lstatSync(destPath, { throwIfNoEntry: false });
      if (stat) {
        if (stat.isSymbolicLink()) {
          const existingTarget = fs.readlinkSync(destPath);
          const normalizedExisting = path.resolve(path.dirname(destPath), existingTarget);
          if (normalizedExisting === path.resolve(srcPath)) {
            console.log(`OK    ${link.dest} - already linked`);
            skipped++;
            continue;
          }
        }
        if (replace) {
          removeExisting(destPath);
          console.log(`REMV  ${link.dest} - removed existing`);
        } else {
          console.log(`SKIP  ${link.dest} - already exists (remove manually to re-link, or use --replace)`);
          skipped++;
          continue;
        }
      }

      const symlinkType = isWindows ? (link.type === 'dir' ? 'junction' : 'file') : undefined;
      fs.symlinkSync(srcPath, destPath, symlinkType);
      console.log(`LINK  ${link.dest} - ${srcPath}`);
      created++;
    } catch (err) {
      console.log(`ERR   ${link.dest} - ${err.message}`);
      if (isWindows && err.message.includes('privilege')) {
        console.log('      Hint: Enable Developer Mode in Windows Settings, or run as Administrator');
      }
      errors++;
    }
  }

  // Process Codex links
  console.log('\n--- Codex ---');
  // Convert any legacy `~/.codex/skills` junction into a real directory before
  // creating per-skill links (otherwise they self-reference into the repo).
  ensureRealDir(path.join(codexDir, 'skills'));
  for (const link of getCodexLinks()) {
    const srcPath = path.join(sourceDir, link.src);
    const destPath = path.join(codexDir, link.dest);

    if (!fs.existsSync(srcPath)) {
      console.log(`SKIP  ${link.dest} - source not found: ${srcPath}`);
      skipped++;
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    try {
      const stat = fs.lstatSync(destPath, { throwIfNoEntry: false });
      if (stat) {
        if (stat.isSymbolicLink()) {
          const existingTarget = fs.readlinkSync(destPath);
          const normalizedExisting = path.resolve(path.dirname(destPath), existingTarget);
          if (normalizedExisting === path.resolve(srcPath)) {
            console.log(`OK    ${link.dest} - already linked`);
            skipped++;
            continue;
          }
        }
        if (replace) {
          removeExisting(destPath);
          console.log(`REMV  ${link.dest} - removed existing`);
        } else {
          console.log(`SKIP  ${link.dest} - already exists (remove manually to re-link, or use --replace)`);
          skipped++;
          continue;
        }
      }

      const symlinkType = isWindows ? (link.type === 'dir' ? 'junction' : 'file') : undefined;
      fs.symlinkSync(srcPath, destPath, symlinkType);
      console.log(`LINK  ${link.dest} - ${srcPath}`);
      created++;
    } catch (err) {
      console.log(`ERR   ${link.dest} - ${err.message}`);
      if (isWindows && err.message.includes('privilege')) {
        console.log('      Hint: Enable Developer Mode in Windows Settings, or run as Administrator');
      }
      errors++;
    }
  }

  // Clone or update cc-market (community plugin marketplace)
  console.log('\n--- Plugins (cc-market) ---');
  const ccMarketDir = path.join(sourceDir, 'cc-market');
  if (fs.existsSync(path.join(ccMarketDir, '.git'))) {
    try {
      execFileSync('git', ['pull', '--ff-only'], { cwd: ccMarketDir, stdio: 'pipe' });
      console.log('OK    cc-market - pulled latest');
    } catch {
      console.log('OK    cc-market - already exists (could not pull)');
    }
  } else if (fs.existsSync(ccMarketDir)) {
    console.log('SKIP  cc-market - directory exists but is not a git repo');
  } else {
    try {
      execFileSync('git', ['clone', 'https://github.com/DawnEver/cc-market'], { cwd: sourceDir, stdio: 'pipe' });
      console.log('OK    cc-market - cloned from https://github.com/DawnEver/cc-market');
    } catch (err) {
      console.log(`ERR   cc-market - ${err.stderr?.toString().trim() || err.message}`);
      errors++;
    }
  }
  // Ensure takeover is enabled in claude_settings.json (migrate existing installs)
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let changed = false;

      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (!('takeover@cc-market' in settings.enabledPlugins)) {
        settings.enabledPlugins['takeover@cc-market'] = true;
        changed = true;
      }

      if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {};
      if (!settings.extraKnownMarketplaces['cc-market']) {
        settings.extraKnownMarketplaces['cc-market'] = {
          source: { source: 'github', repo: 'DawnEver/cc-market' }
        };
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('OK    takeover plugin - added to claude_settings.json');
      } else if (settings.enabledPlugins['takeover@cc-market']) {
        console.log('OK    takeover plugin - already enabled');
      } else {
        console.log('OK    takeover plugin - disabled (user preference preserved)');
      }
    } catch (err) {
      console.log(`WARN  could not update claude_settings.json - ${err.message}`);
    }
  }

  // Fix LSP commands on Windows (.cmd extension required)
  fixLspWindows();

  // Check macOS notification helper
  if (process.platform === 'darwin') {
    console.log('\n--- macOS Notifications ---');
    if (!checkMacNotify()) errors++;
  }

  // Install shell aliases
  console.log('\n--- Shell Aliases ---');
  installShellAliases(claudeDir, sourceDir);

  console.log(`\nDone: ${created} linked, ${skipped} skipped, ${errors} errors`);
}

if (path.resolve(process.argv[1] || '') === path.resolve(__dirname, 'setup.js')) {
  setup();
}
