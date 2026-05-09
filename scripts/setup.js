#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, '..');
const claudeDir = path.join(os.homedir(), '.claude');
const codexDir = path.join(os.homedir(), '.codex');

const EXTENSION_NAME = 'claude-notifications-0.0.1';

const CLAUDE_LINKS = [
  { src: 'GLOBAL-AGENTS.md', dest: 'CLAUDE.md', type: 'file' },
  { src: 'claude_settings.json', dest: 'settings.json', type: 'file' },
  { src: path.join('claude_plugins', 'claude-hud', 'config.json'), dest: path.join('plugins', 'claude-hud', 'config.json'), type: 'file' },
  { src: 'skills', dest: 'skills', type: 'dir' },
  { src: 'agents', dest: 'agents', type: 'dir' },
  { src: 'scripts', dest: 'scripts', type: 'dir' },
  { src: 'models.md', dest: 'models.md', type: 'file' },
  { src: path.join('vscode-extension', 'claude-notifications'), dest: path.join('.vscode', 'extensions', EXTENSION_NAME), type: 'dir', isExtension: true },
];

const CODEX_LINKS = [
  { src: 'codex_config.toml', dest: 'config.toml', type: 'file' },
];

const isWindows = process.platform === 'win32';

function removeExisting(destPath, type) {
  const stat = fs.lstatSync(destPath, { throwIfNoEntry: false });
  if (!stat) return false;

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(destPath, { recursive: true, force: true });
    return true;
  }
  fs.unlinkSync(destPath);
  return true;
}

function setup() {
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
    console.log('COPY  claude_settings.template.json → claude_settings.json');
  }

  let created = 0, skipped = 0, errors = 0;

  // Process Claude links
  console.log('--- Claude ---');
  for (const link of CLAUDE_LINKS) {
    const srcPath = path.join(sourceDir, link.src);
    const baseDir = link.isExtension ? os.homedir() : claudeDir;
    const destPath = path.join(baseDir, link.dest);

    if (!fs.existsSync(srcPath)) {
      console.log(`SKIP  ${link.dest} — source not found: ${srcPath}`);
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
            console.log(`OK    ${link.dest} — already linked`);
            skipped++;
            continue;
          }
        }
        if (replace) {
          removeExisting(destPath, link.type);
          console.log(`REMV  ${link.dest} — removed existing`);
        } else {
          console.log(`SKIP  ${link.dest} — already exists (remove manually to re-link, or use --replace)`);
          skipped++;
          continue;
        }
      }

      const symlinkType = isWindows ? (link.type === 'dir' ? 'junction' : 'file') : undefined;
      fs.symlinkSync(srcPath, destPath, symlinkType);
      console.log(`LINK  ${link.dest} → ${srcPath}`);
      created++;
    } catch (err) {
      console.log(`ERR   ${link.dest} — ${err.message}`);
      if (isWindows && err.message.includes('privilege')) {
        console.log('      Hint: Enable Developer Mode in Windows Settings, or run as Administrator');
      }
      errors++;
    }
  }

  // Process Codex links
  console.log('\n--- Codex ---');
  for (const link of CODEX_LINKS) {
    const srcPath = path.join(sourceDir, link.src);
    const destPath = path.join(codexDir, link.dest);

    if (!fs.existsSync(srcPath)) {
      console.log(`SKIP  ${link.dest} — source not found: ${srcPath}`);
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
            console.log(`OK    ${link.dest} — already linked`);
            skipped++;
            continue;
          }
        }
        if (replace) {
          removeExisting(destPath, link.type);
          console.log(`REMV  ${link.dest} — removed existing`);
        } else {
          console.log(`SKIP  ${link.dest} — already exists (remove manually to re-link, or use --replace)`);
          skipped++;
          continue;
        }
      }

      const symlinkType = isWindows ? (link.type === 'dir' ? 'junction' : 'file') : undefined;
      fs.symlinkSync(srcPath, destPath, symlinkType);
      console.log(`LINK  ${link.dest} → ${srcPath}`);
      created++;
    } catch (err) {
      console.log(`ERR   ${link.dest} — ${err.message}`);
      if (isWindows && err.message.includes('privilege')) {
        console.log('      Hint: Enable Developer Mode in Windows Settings, or run as Administrator');
      }
      errors++;
    }
  }

  // Initialize git submodules (required for internal symlinks below)
  const gitDir = path.join(sourceDir, '.git');
  if (fs.existsSync(gitDir)) {
    console.log('\n--- Git ---');
    try {
      execSync('git submodule update --init --recursive', { cwd: sourceDir, stdio: 'pipe' });
      console.log('OK    git submodules initialized');
    } catch (err) {
      console.log(`ERR   git submodules — ${err.stderr?.toString().trim() || err.message}`);
      errors++;
    }
  }

  // Internal repo links (symlinks within the source directory)
  const INTERNAL_LINKS = [
    { name: 'skills/planning-with-files', target: path.join('.submodules', 'planning-with-files', 'skills', 'planning-with-files') },
  ];

  if (INTERNAL_LINKS.length > 0) {
    console.log('\n--- Internal ---');
    for (const link of INTERNAL_LINKS) {
      const linkPath = path.join(sourceDir, link.name);
      const targetPath = path.join(sourceDir, link.target);

      if (!fs.existsSync(targetPath)) {
        console.log(`SKIP  ${link.name} — target not found: ${targetPath}`);
        skipped++;
        continue;
      }

      try {
        const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
        if (stat) {
          let isLink = stat.isSymbolicLink();
          if (!isLink) {
            // Windows junctions may not report as symbolic links — try readlink
            try {
              fs.readlinkSync(linkPath);
              isLink = true;
            } catch { /* not a link/junction */ }
          }
          if (isLink) {
            const existingTarget = fs.readlinkSync(linkPath);
            const normalizedExisting = path.resolve(path.dirname(linkPath), existingTarget);
            if (normalizedExisting === path.resolve(targetPath)) {
              console.log(`OK    ${link.name} — already linked`);
              skipped++;
              continue;
            }
            // Link exists but points to wrong target — remove and re-create
            fs.unlinkSync(linkPath);
            console.log(`REMV  ${link.name} — removed existing link (wrong target)`);
          } else if (replace) {
            removeExisting(linkPath, 'dir');
            console.log(`REMV  ${link.name} — removed existing`);
          } else {
            console.log(`SKIP  ${link.name} — already exists (remove manually to re-link, or use --replace)`);
            skipped++;
            continue;
          }
        }

        const symlinkType = isWindows ? 'junction' : undefined;
        fs.symlinkSync(targetPath, linkPath, symlinkType);
        console.log(`LINK  ${link.name} → ${link.target}`);
        created++;
      } catch (err) {
        console.log(`ERR   ${link.name} — ${err.message}`);
        if (isWindows && err.message.includes('privilege')) {
          console.log('      Hint: Enable Developer Mode in Windows Settings, or run as Administrator');
        }
        errors++;
      }
    }
  }

  // Build VS Code extension
  const extensionDir = path.join(sourceDir, 'vscode-extension', 'claude-notifications');
  if (fs.existsSync(path.join(extensionDir, 'package.json'))) {
    console.log('\n--- Extension ---');
    try {
        console.log('Try   npm install');
        execSync('npm install', { cwd: extensionDir, stdio: 'pipe' });
      console.log('OK    npm install');
    } catch (err) {
      console.log(`ERR   npm install — ${err.stderr?.toString().trim() || err.message}`);
      errors++;
    }
    try {
      console.log('Try   npm run compile');
      execSync('npm run compile', { cwd: extensionDir, stdio: 'pipe' });
      console.log('OK    npm run compile');
    } catch (err) {
      console.log(`ERR   npm run compile — ${err.stderr?.toString().trim() || err.message}`);
      errors++;
    }
    console.log('Try reloading VS Code window to activate extension');
  }

  console.log(`\nDone: ${created} linked, ${skipped} skipped, ${errors} errors`);
}

setup();
