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

// Locate the bin directory of a command on PATH, or null if not found.
export function locateBinDir(cmd, run = (c) => execFileSync(isWindows ? 'where' : 'which', [c], { stdio: 'pipe' }).toString()) {
  try {
    const first = run(cmd).trim().split(/\r?\n/)[0].trim();
    return first ? path.dirname(first) : null;
  } catch {
    return null;
  }
}

// Decide where to drop the CLI wrappers. Provider-independent tools (todo,
// traceme) only need *some* bin dir on PATH; the claude-bound launchers
// (ccc/ccds) additionally need the claude binary, and the codex-bound launchers
// (cods/cogmi) need the codex binary. `targetBin` is the fallback for the
// provider-independent tools — prefer claude, fall back to codex.
export function resolveAliasBinDirs(locate = locateBinDir) {
  const claudeBin = locate('claude');
  const codexBin = locate('codex');
  const targetBin = claudeBin || codexBin;
  return { claudeBin, codexBin, targetBin };
}

export function installShellAliases(claudeDir, sourceDir) {
  // Place wrappers alongside an installed host binary so they land on PATH.
  // On Windows: write .cmd (CMD/PowerShell) + no-extension script (Git Bash).
  // On macOS/Linux: write no-extension shell script only.
  const { claudeBin, codexBin, targetBin } = resolveAliasBinDirs();
  if (!targetBin) {
    console.log('SKIP  aliases - could not locate claude or codex executable');
    return;
  }

  // Use forward slashes so the path works in both node on Windows and sh on Git Bash
  const ccJsPath = path.join(claudeDir, 'scripts', 'runtime', 'cc.js').replace(/\\/g, '/');
  // The codex launcher lives at `~/.claude/scripts/runtime/codex.js` rather than
  // `~/.codex/...` because setup always links `<repo>/scripts` to `~/.claude/scripts`
  // (CLAUDE_LINKS, line 27) regardless of which CLI binaries are installed — so
  // even a codex-only machine gets a working `~/.claude/scripts/runtime/codex.js`.
  // Routing the codex aliases through a codex-local path would require either a
  // parallel `scripts/` link under CODEX_LINKS (duplicate symlink target) or
  // shipping a separate copy of codex.js — both are heavier than the current
  // shared-root design. The single-`scripts`-root is intentional.
  const codexJsPath = path.join(claudeDir, 'scripts', 'runtime', 'codex.js').replace(/\\/g, '/');
  const resolveRepo = (rel) => path.join(sourceDir, rel).replace(/\\/g, '/');

  // ccc/ccds launch the `claude` binary (see cc.js), so install them only when
  // claude is present — they are inert under a Codex-only install.
  if (claudeBin) {
    const ALIASES = [
      { name: 'ccc',  provider: 'claude'   },
      { name: 'ccds', provider: 'deepseek' },
      { name: 'cckm', provider: 'kimi'     },
      { name: 'ccgmi', provider: 'gmi'     },
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
    console.log('      ccds    - DeepSeek API (Anthropic-compatible, direct)');
    console.log('      cckm    - Kimi API (Anthropic-compatible, direct)');
    console.log('      ccgmi   - GMI Cloud (Anthropic-compatible, direct)');
  } else {
    console.log('      ccc/ccds/cckm/ccgmi - skipped (claude binary not found; Codex-only install)');
  }

  // cods/cogmi launch the `codex` binary (see codex.js), so install them only
  // when codex is present — they are inert under a Claude-only install.
  if (codexBin) {
    const CODEX_ALIASES = [
      { name: 'cods',  provider: 'deepseek' },
      { name: 'cogmi', provider: 'gmi' },
    ];

    for (const { name, provider } of CODEX_ALIASES) {
      if (isWindows) {
        const cmdContent = `@echo off\nrem claude-code-alias\nnode "${codexJsPath}" ${provider} %*\n`;
        writeIfChanged(path.join(codexBin, `${name}.cmd`), cmdContent, `${name}.cmd`);
      }

      const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${codexJsPath}" ${provider} "$@"\n`;
      const shPath = path.join(codexBin, name);
      const result = writeIfChanged(shPath, shContent, name);
      if (!isWindows && result !== 'skipped') fs.chmodSync(shPath, 0o755);
    }

    console.log('      cods    - Codex + DeepSeek (single-source-of-truth: providers.deepseek)');
    console.log('      cogmi   - Codex + GMI Cloud (single-source-of-truth: providers.gmi)');
  } else {
    console.log('      cods/cogmi - skipped (codex binary not found)');
  }

  // Provider-independent tools install to whichever host bin dir we found.
  // TraceMe CLI alias — dynamic launcher survives plugin version updates
  const tracemeLauncher = resolveRepo('scripts/runtime/traceme-launcher.mjs');
  if (isWindows) {
    const cmdContent = `@echo off\nrem claude-code-alias\nnode "${tracemeLauncher}" %*\n`;
    writeIfChanged(path.join(targetBin, 'traceme.cmd'), cmdContent, 'traceme.cmd');
  }
  const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${tracemeLauncher}" "$@"\n`;
  const shPath = path.join(targetBin, 'traceme');
  const result = writeIfChanged(shPath, shContent, 'traceme');
  if (!isWindows && result !== 'skipped') fs.chmodSync(shPath, 0o755);

  console.log('      traceme - Claude Code observability (token/cost reports)');

  // Todo CLI alias — task management
  const todoLauncher = resolveRepo('scripts/runtime/todo-launcher.mjs');
  if (isWindows) {
    const cmdContent = `@echo off\nrem claude-code-alias\nnode "${todoLauncher}" %*\n`;
    writeIfChanged(path.join(targetBin, 'todo.cmd'), cmdContent, 'todo.cmd');
  }
  const todoShContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${todoLauncher}" "$@"\n`;
  const todoShPath = path.join(targetBin, 'todo');
  const todoResult = writeIfChanged(todoShPath, todoShContent, 'todo');
  if (!isWindows && todoResult !== 'skipped') fs.chmodSync(todoShPath, 0o755);

  console.log('      todo    - Task management CLI');
  console.log(`      installed to: ${targetBin}`);

  if (isWindows) installPowerShellProfileAliasSource(claudeDir);
}
