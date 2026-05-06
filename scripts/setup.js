#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, '..');
const claudeDir = path.join(os.homedir(), '.claude');

const EXTENSION_NAME = 'claude-notifications-0.0.1';

const LINKS = [
  { src: 'GLOBAL-CLAUDE.md', dest: 'CLAUDE.md', type: 'file' },
  { src: 'settings.json', dest: 'settings.json', type: 'file' },
  { src: path.join('plugins', 'claude-hud', 'config.json'), dest: path.join('plugins', 'claude-hud', 'config.json'), type: 'file' },
  { src: 'skills', dest: 'skills', type: 'dir' },
  { src: 'agents', dest: 'agents', type: 'dir' },
  { src: 'scripts', dest: 'scripts', type: 'dir' },
  { src: 'models.md', dest: 'models.md', type: 'file' },
  { src: path.join('vscode-extension', 'claude-notifications'), dest: path.join('.vscode', 'extensions', EXTENSION_NAME), type: 'dir', isExtension: true },
];

const isWindows = process.platform === 'win32';

function setup() {
  console.log(`Source: ${sourceDir}`);
  console.log(`Target: ${claudeDir}\n`);

  // Ensure settings.json exists (copy from template if not)
  const settingsPath = path.join(sourceDir, 'settings.json');
  const templatePath = path.join(sourceDir, 'settings.template.json');
  if (!fs.existsSync(settingsPath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, settingsPath);
    console.log('COPY  settings.template.json → settings.json');
  }

  let created = 0, skipped = 0, errors = 0;

  for (const link of LINKS) {
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
        console.log(`SKIP  ${link.dest} — already exists (remove manually to re-link)`);
        skipped++;
        continue;
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
        } else {
          console.log(`SKIP  ${link.name} — already exists (remove manually to re-link)`);
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

  console.log(`\nDone: ${created} linked, ${skipped} skipped, ${errors} errors`);
}

setup();
