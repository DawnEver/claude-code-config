#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { fixLspWindows } from './fix-lsp-windows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(__dirname, '../..');
const claudeDir = path.join(os.homedir(), '.claude');
const codexDir = path.join(os.homedir(), '.codex');

const CLAUDE_LINKS = [
  { src: 'GLOBAL-AGENTS.md', dest: 'CLAUDE.md', type: 'file' },
  { src: 'claude_settings.json', dest: 'settings.json', type: 'file' },
  { src: path.join('claude_plugins', 'claude-hud', 'config.json'), dest: path.join('plugins', 'claude-hud', 'config.json'), type: 'file' },
  { src: 'skills', dest: 'skills', type: 'dir' },
  { src: 'agents', dest: 'agents', type: 'dir' },
  { src: 'scripts', dest: 'scripts', type: 'dir' },
  { src: 'claude_env_settings.json', dest: 'claude_env_settings.json', type: 'file' },
  { src: 'keybindings.json', dest: 'keybindings.json', type: 'file' },
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
    const baseDir = link.isExtension ? os.homedir() : claudeDir;
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
          removeExisting(destPath, link.type);
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
  for (const link of CODEX_LINKS) {
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
          removeExisting(destPath, link.type);
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
      execSync('git pull --ff-only', { cwd: ccMarketDir, stdio: 'pipe' });
      console.log('OK    cc-market - pulled latest');
    } catch {
      console.log('OK    cc-market - already exists (could not pull)');
    }
  } else if (fs.existsSync(ccMarketDir)) {
    console.log('SKIP  cc-market - directory exists but is not a git repo');
  } else {
    try {
      execSync('git clone https://github.com/DawnEver/cc-market', { cwd: sourceDir, stdio: 'pipe' });
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
    console.log('SKIP  aliases - could not locate claude executable');
    return;
  }

  // Use forward slashes so the path works in both node on Windows and sh on Git Bash
  const ccJsPath = path.join(claudeDir, 'scripts', 'runtime', 'cc.js').replace(/\\/g, '/');

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

  console.log('      cc   - Claude Pro (official subscription)');
  console.log('      ccds - DeepSeek API');
  console.log(`      installed to: ${claudeBin}`);

}

// Returns 'written' | 'ok' | 'skipped'
function writeIfChanged(filePath, content, label, marker) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (existing === null) {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} - ${filePath}`);
    return 'written';
  } else if (existing === content) {
    console.log(`OK    ${label} - already up to date`);
    return 'ok';
  } else if (marker && !existing.includes(marker)) {
    console.log(`SKIP  ${label} - file exists and was not created by this setup (remove manually to replace)`);
    return 'skipped';
  } else {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} - updated`);
    return 'written';
  }
}

setup();
