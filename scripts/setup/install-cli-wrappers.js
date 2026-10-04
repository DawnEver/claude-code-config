// Cross-platform CLI wrapper installation —  writes .cmd (Windows) and shell scripts (POSIX)
// alongside the claude binary so ccc/ccds/codc/cods/todo are on PATH.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const isWindows = process.platform === 'win32';
const MARKER = '# claude-code-alias';
// The .cmd wrappers carry the same marker as a batch comment. Recognising only the `#`
// form meant setup treated every .cmd it had written itself as a third-party file and
// refused to update it — a `.cmd` wrapper kept pointing at a repo path deleted months
// earlier, so the CMD/PowerShell wrapper was dead while the Git Bash one worked.
const CMD_MARKER = 'rem claude-code-alias';
// Exported so migrate's orphan sweep asks the same question — it had its own copy of the
// `#`-only check, which is why `cogmi` was removed but `cogmi.cmd` was left behind.
export const isManagedWrapper = (content) => content.includes(MARKER) || content.includes(CMD_MARKER);

// Returns 'written' | 'ok' | 'skipped'
// `mode` is (re)applied to every wrapper we own, so a lost execute bit self-heals.
function writeIfChanged(filePath, content, label, mode) {
  const result = writeWrapper(filePath, content, label);
  if (mode && !isWindows && result !== 'skipped') fs.chmodSync(filePath, mode);
  return result;
}

function writeWrapper(filePath, content, label) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (existing === null) {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} - ${filePath}`);
    return 'written';
  } else if (existing === content) {
    console.log(`OK    ${label} - already up to date`);
    return 'ok';
  } else if (!isManagedWrapper(existing)) {
    console.log(`SKIP  ${label} - file exists and was not created by this setup (remove manually to replace)`);
    return 'skipped';
  } else {
    fs.writeFileSync(filePath, content);
    console.log(`WRITE ${label} - updated`);
    return 'written';
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

const isWritableDir = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

// Every wrapper lives in ONE dir: the first host bin dir (claude, then codex) that is on
// PATH by construction and writable by this user. A host installed into a root-owned dir
// (e.g. /usr/local/bin) is skipped — setup must never need sudo, because a root run also
// leaves ~/.claude.json root-owned and forces a re-login on every start.
export function resolveWrapperBinDirs(locate = locateBinDir, writable = isWritableDir) {
  const claudeBin = locate('claude');
  const codexBin = locate('codex');
  const binDir = [claudeBin, codexBin].find((d) => d && writable(d)) ?? null;
  return { hasClaude: !!claudeBin, hasCodex: !!codexBin, binDir };
}
export function wrapperPaths(binDir, name, windows = isWindows) {
  return windows ? [path.join(binDir, `${name}.cmd`), path.join(binDir, name)] : [path.join(binDir, name)];
}

/** Remove only the exact source lines written by older setup versions. */
export function removeLegacyProfileSources(home = os.homedir(), platform = process.platform) {
  const profiles = platform === 'win32'
    ? [path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')]
    : [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
  const sourceLines = new Set([
    '. ~/.claude/scripts/runtime/aliases.ps1', '. ~/.claude/scripts/shell/aliases.ps1',
    '. ~/.claude/scripts/runtime/aliases.sh', '. ~/.claude/scripts/shell/aliases.sh',
  ]);
  for (const profile of profiles) {
    if (!fs.existsSync(profile)) continue;
    const original = fs.readFileSync(profile, 'utf8');
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const next = original.split(/\r?\n/).filter((line) => !sourceLines.has(line.trim())).join(eol);
    if (next !== original) fs.writeFileSync(profile, next);
  }
}

export function installCliWrappers(claudeDir) {
  removeLegacyProfileSources();
  // On Windows: write .cmd (CMD/PowerShell) + no-extension script (Git Bash).
  // On macOS/Linux: write no-extension shell script only.
  const { hasClaude, hasCodex, binDir } = resolveWrapperBinDirs();
  if (!binDir) {
    console.log('SKIP  wrappers - no user-writable claude/codex bin dir (never re-run setup with sudo)');
    return;
  }

  // Use forward slashes so the path works in both node on Windows and sh on Git Bash
  const ccJsPath = path.join(claudeDir, 'scripts', 'runtime', 'cc.js').replace(/\\/g, '/');
  // The codex launcher lives at `~/.claude/scripts/runtime/codex.js` rather than
  // `~/.codex/...` because setup always links `<repo>/scripts` to `~/.claude/scripts`
  // (CLAUDE_LINKS, line 27) regardless of which CLI binaries are installed — so
  // even a codex-only machine gets a working `~/.claude/scripts/runtime/codex.js`.
  // Routing the Codex wrappers through a codex-local path would require either a
  // parallel `scripts/` link under CODEX_LINKS (duplicate symlink target) or
  // shipping a separate copy of codex.js — both are heavier than the current
  // shared-root design. The single-`scripts`-root is intentional.
  const codexJsPath = path.join(claudeDir, 'scripts', 'runtime', 'codex.js').replace(/\\/g, '/');
  // Route through ~/.claude/scripts for the same reason as cc.js/codex.js above: that is a
  // symlink setup maintains, so the wrapper survives the repo moving. Baking sourceDir in
  // meant every relocation silently broke `todo` until setup was re-run --
  // and unlike the provider launchers, nothing else would have hinted at why.
  const resolveScript = (rel) => path.join(claudeDir, 'scripts', rel).replace(/\\/g, '/');

  // ccc/ccds launch the `claude` binary (see cc.js), so install them only when
  // claude is present — they are inert under a Codex-only install.
  if (hasClaude) {
    const ALIASES = [
      { name: 'ccc',  provider: 'claude'   },
      { name: 'ccds', provider: 'deepseek' },
    ];

    for (const { name, provider } of ALIASES) {
      if (isWindows) {
        const cmdContent = `@echo off\nrem claude-code-alias\nnode "${ccJsPath}" ${provider} %*\n`;
        writeIfChanged(path.join(binDir, `${name}.cmd`), cmdContent, `${name}.cmd`);
      }

      const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${ccJsPath}" ${provider} "$@"\n`;
      const shPath = path.join(binDir, name);
      writeIfChanged(shPath, shContent, name, 0o755);
    }

    console.log('      ccc     - Claude (official subscription)');
    console.log('      ccds    - DeepSeek API (Anthropic-compatible, direct)');
  } else {
    console.log('      ccc/ccds - skipped (claude binary not found; Codex-only install)');
  }

  // cods launches the `codex` binary (see codex.js), so install it only when codex is
  // present — it is inert under a Claude-only install.
  //
  if (hasCodex) {
    const CODEX_ALIASES = [
      { name: 'codc',  provider: 'codex' },
      { name: 'cods',  provider: 'deepseek' },
    ];

    for (const { name, provider } of CODEX_ALIASES) {
      if (isWindows) {
        const cmdContent = `@echo off\nrem claude-code-alias\nnode "${codexJsPath}" ${provider} %*\n`;
        writeIfChanged(path.join(binDir, `${name}.cmd`), cmdContent, `${name}.cmd`);
      }

      const shContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${codexJsPath}" ${provider} "$@"\n`;
      const shPath = path.join(binDir, name);
      writeIfChanged(shPath, shContent, name, 0o755);
    }

    console.log('      codc    - Codex official provider + startup sync');
    console.log('      cods    - Codex + DeepSeek (single-source-of-truth: providers.deepseek)');
  } else {
    console.log('      codc/cods - skipped (codex binary not found)');
  }

  // Todo CLI wrapper — task management
  const todoLauncher = resolveScript('runtime/todo-launcher.mjs');
  if (isWindows) {
    const cmdContent = `@echo off\nrem claude-code-alias\nnode "${todoLauncher}" %*\n`;
    writeIfChanged(path.join(binDir, 'todo.cmd'), cmdContent, 'todo.cmd');
  }
  const todoShContent = `#!/usr/bin/env sh\n${MARKER}\nexec node "${todoLauncher}" "$@"\n`;
  const todoShPath = path.join(binDir, 'todo');
  writeIfChanged(todoShPath, todoShContent, 'todo', 0o755);

  console.log('      todo    - Task management CLI');
  console.log(`      installed to: ${binDir}`);
}
