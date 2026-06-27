// Shell alias installation — writes .cmd (Windows) and shell scripts (POSIX)
// alongside the claude binary so ccc/ccds/traceme/todo are on PATH.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const isWindows = process.platform === 'win32';
const MARKER = '# claude-code-alias';

// Returns 'written' | 'ok' | 'skipped'
function writeIfChanged(filePath, content, label) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (existing === null) {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} - ${filePath}`);
    return 'written';
  } else if (existing === content) {
    console.log(`OK    ${label} - already up to date`);
    return 'ok';
  } else if (!existing.includes(MARKER)) {
    console.log(`SKIP  ${label} - file exists and was not created by this setup (remove manually to replace)`);
    return 'skipped';
  } else {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} - updated`);
    return 'written';
  }
}

function installPowerShellProfileAliasSource(claudeDir) {
  const profilePath = path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  const oldSource = '. ~/.claude/scripts/shell/aliases.ps1';
  const sourceLine = '. ~/.claude/scripts/runtime/aliases.ps1';

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  const normalized = existing.replace(/\r\n/g, '\n');

  let next = normalized;
  if (next.includes(oldSource)) {
    next = next.replaceAll(oldSource, sourceLine);
  } else if (!next.includes(sourceLine)) {
    const prefix = next.trimEnd();
    next = `${prefix}${prefix ? '\n\n' : ''}# Claude Code aliases\n${sourceLine}\n`;
  }

  if (next !== normalized) {
    fs.writeFileSync(profilePath, next.replace(/\n/g, os.EOL));
    console.log(`WRITE PowerShell profile - ${profilePath}`);
  } else {
    console.log('OK    PowerShell profile - already up to date');
  }
}

export function installShellAliases(claudeDir, sourceDir) {
  // Find the directory where `claude` is installed and place wrappers alongside it.
  // On Windows: write .cmd (CMD/PowerShell) + no-extension script (Git Bash).
  // On macOS/Linux: write no-extension shell script only.
  let claudeBin;
  try {
    const raw = execFileSync(isWindows ? 'where' : 'which', ['claude'], { stdio: 'pipe' })
      .toString().trim().split(/\r?\n/)[0].trim();
    claudeBin = path.dirname(raw);
  } catch {
    console.log('SKIP  aliases - could not locate claude executable');
    return;
  }

  // Use forward slashes so the path works in both node on Windows and sh on Git Bash
  const ccJsPath = path.join(claudeDir, 'scripts', 'runtime', 'cc.js').replace(/\\/g, '/');
  const resolveRepo = (rel) => path.join(sourceDir, rel).replace(/\\/g, '/');

  const ALIASES = [
    { name: 'ccc',  provider: 'claude'   },
    { name: 'ccds', provider: 'deepseek' },
  ];

  for (const { name, provider } of ALIASES) {
    if (isWindows) {
      const cmdContent = `@echo off\nrem claude-code-alias\nnode "${ccJsPath}" ${provider} %*\n`;
      writeIfChanged(path.join(claudeBin, `${name}.cmd`), cmdContent, `${name}.cmd`);
    }

    const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${ccJsPath}" ${provider} "$@"\n`;
    const shPath = path.join(claudeBin, name);
    const result = writeIfChanged(shPath, shContent, name);
    // chmod whenever the file is ours (written or already up-to-date), not for skipped third-party files
    if (!isWindows && result !== 'skipped') fs.chmodSync(shPath, 0o755);
  }

  console.log('      ccc     - Claude (official subscription)');
  console.log('      ccds    - DeepSeek API (Foundry mode, direct)');

  // TraceMe CLI alias — dynamic launcher survives plugin version updates
  const tracemeLauncher = resolveRepo('scripts/runtime/traceme-launcher.mjs');
  if (isWindows) {
    const cmdContent = `@echo off\nrem claude-code-alias\nnode "${tracemeLauncher}" %*\n`;
    writeIfChanged(path.join(claudeBin, 'traceme.cmd'), cmdContent, 'traceme.cmd');
  }
  const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${tracemeLauncher}" "$@"\n`;
  const shPath = path.join(claudeBin, 'traceme');
  const result = writeIfChanged(shPath, shContent, 'traceme');
  if (!isWindows && result !== 'skipped') fs.chmodSync(shPath, 0o755);

  console.log('      traceme - Claude Code observability (token/cost reports)');

  // Todo CLI alias — task management
  const todoLauncher = resolveRepo('scripts/runtime/todo-launcher.mjs');
  if (isWindows) {
    const cmdContent = `@echo off\nrem claude-code-alias\nnode "${todoLauncher}" %*\n`;
    writeIfChanged(path.join(claudeBin, 'todo.cmd'), cmdContent, 'todo.cmd');
  }
  const todoShContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${todoLauncher}" "$@"\n`;
  const todoShPath = path.join(claudeBin, 'todo');
  const todoResult = writeIfChanged(todoShPath, todoShContent, 'todo');
  if (!isWindows && todoResult !== 'skipped') fs.chmodSync(todoShPath, 0o755);

  console.log('      todo    - Task management CLI');
  console.log(`      installed to: ${claudeBin}`);

  if (isWindows) installPowerShellProfileAliasSource(claudeDir);
}
