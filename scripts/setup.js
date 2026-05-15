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

const CLAUDE_LINKS = [
  { src: 'GLOBAL-AGENTS.md', dest: 'CLAUDE.md', type: 'file' },
  { src: 'claude_settings.json', dest: 'settings.json', type: 'file' },
  { src: path.join('claude_plugins', 'claude-hud', 'config.json'), dest: path.join('plugins', 'claude-hud', 'config.json'), type: 'file' },
  { src: 'skills', dest: 'skills', type: 'dir' },
  { src: 'agents', dest: 'agents', type: 'dir' },
  { src: 'scripts', dest: 'scripts', type: 'dir' },
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

  // Ensure codex_config.toml exists (copy from template if not)
  const codexConfigPath = path.join(sourceDir, 'codex_config.toml');
  const codexConfigTemplatePath = path.join(sourceDir, 'codex_config.template.toml');
  if (!fs.existsSync(codexConfigPath) && fs.existsSync(codexConfigTemplatePath)) {
    fs.copyFileSync(codexConfigTemplatePath, codexConfigPath);
    console.log('COPY  codex_config.template.toml → codex_config.toml');
  }

  // Ensure claude_env_settings.json exists (copy from template if not)
  const envSettingsPath = path.join(sourceDir, 'claude_env_settings.json');
  const envSettingsTemplatePath = path.join(sourceDir, 'claude_env_settings.template.json');
  if (!fs.existsSync(envSettingsPath) && fs.existsSync(envSettingsTemplatePath)) {
    fs.copyFileSync(envSettingsTemplatePath, envSettingsPath);
    console.log('COPY  claude_env_settings.template.json → claude_env_settings.json');
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

  // Install shell aliases
  console.log('\n--- Shell Aliases ---');
  installShellAliases();

  console.log(`\nDone: ${created} linked, ${skipped} skipped, ${errors} errors`);
}

function installShellAliases() {
  // Find the directory where `claude` is installed and place wrappers alongside it.
  // On Windows: write .cmd (CMD/PowerShell) + no-extension script (Git Bash).
  // On macOS/Linux: write no-extension shell script only.
  let claudeBin;
  try {
    const raw = execSync(isWindows ? 'where claude' : 'which claude', { stdio: 'pipe' })
      .toString().trim().split(/\r?\n/)[0].trim();
    claudeBin = path.dirname(raw);
  } catch {
    console.log('SKIP  aliases — could not locate claude executable');
    return;
  }

  // Use forward slashes so the path works in both node on Windows and sh on Git Bash
  const ccJsPath = path.join(claudeDir, 'scripts', 'cc.js').replace(/\\/g, '/');

  const ALIASES = [
    { name: 'cc',   provider: 'claude'   },
    { name: 'ccds', provider: 'deepseek' },
  ];

  const MARKER = '# claude-code-alias';

  for (const { name, provider } of ALIASES) {
    if (isWindows) {
      const cmdContent = `@echo off\nrem claude-code-alias\nnode "${ccJsPath}" ${provider} %*\n`;
      writeIfChanged(path.join(claudeBin, `${name}.cmd`), cmdContent, `${name}.cmd`, 'claude-code-alias');
    }

    const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${ccJsPath}" ${provider} "$@"\n`;
    const shPath = path.join(claudeBin, name);
    const result = writeIfChanged(shPath, shContent, name, MARKER);
    // chmod whenever the file is ours (written or already up-to-date), not for skipped third-party files
    if (!isWindows && result !== 'skipped') fs.chmodSync(shPath, 0o755);
  }

  console.log('      cc   → Claude Pro (official subscription)');
  console.log('      ccds → DeepSeek API');
  console.log(`      installed to: ${claudeBin}`);
}

// Returns 'written' | 'ok' | 'skipped'
function writeIfChanged(filePath, content, label, marker) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (existing === null) {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} → ${filePath}`);
    return 'written';
  } else if (existing === content) {
    console.log(`OK    ${label} — already up to date`);
    return 'ok';
  } else if (marker && !existing.includes(marker)) {
    console.log(`SKIP  ${label} — file exists and was not created by this setup (remove manually to replace)`);
    return 'skipped';
  } else {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} — updated`);
    return 'written';
  }
}

setup();
