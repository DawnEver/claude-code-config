// win-spawn.mjs — safe argument passing for the launcher wrappers on Windows.
//
// `spawn(cmd, args, { shell: true })` concatenates args *unescaped* into the cmd.exe
// command line (Node's own DEP0190 warning says so), which drops quoting: a prompt like
// `cods exec "Reply with exactly: OK"` arrived as separate words and Codex rejected it.
//
// `shell: true` was there only because `claude` / `codex` are npm `.cmd` shims, and Node
// refuses to spawn a `.cmd` without a shell. So resolve the command ourselves, and when it
// really is a batch shim, invoke cmd.exe explicitly with arguments we quote — the approach
// npm and cross-spawn use. A resolved `.exe` needs no shell at all.
//
// Pure projection (`buildSpawn`) + one impure PATH lookup (`resolveCommand`), matching the
// `*-launcher.mjs` split so the escaping is unit-testable.

import { existsSync, statSync } from 'fs';
import { join, isAbsolute } from 'path';

// cmd.exe metacharacters. Space is included: escaping it with `^` is what lets an
// unquoted command path containing spaces survive.
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument so cmd.exe passes it through as a single verbatim word. */
export function escapeArgument(arg, doubleEscapeMetaChars = false) {
  let s = String(arg);
  // Backslashes are only special before a quote: double those runs, then escape the quote.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  // Double a trailing run too, so it cannot escape the closing quote we are about to add.
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(META_CHARS, '^$1');
  // A .cmd/.bat shim makes cmd.exe parse the line a second time, so escape twice.
  if (doubleEscapeMetaChars) s = s.replace(META_CHARS, '^$1');
  return s;
}

/** Escape a command path for cmd.exe without quoting it (quotes would defeat `/s`). */
export function escapeCommand(command) {
  return String(command).replace(META_CHARS, '^$1');
}

/**
 * Locate `name` on PATH the way cmd.exe would, trying each PATHEXT extension.
 * Returns the full path, or null when it is not found.
 */
export function resolveCommand(name, { env = process.env, platform = process.platform } = {}) {
  if (isAbsolute(name) && existsSync(name)) return name;
  const isWindows = platform === 'win32';
  const exts = isWindows
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const dirs = (env.PATH || env.Path || '').split(isWindows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable PATH entry — keep looking.
      }
    }
  }
  return null;
}

/**
 * Project a logical (command, args) pair onto what `spawn` should actually be called with.
 * Returns `{ command, args, options }`; merge `options` into the caller's spawn options.
 */
export function buildSpawn({ command, args = [], platform = process.platform, comspec }) {
  // Everywhere but Windows, spawn takes the argv array verbatim — nothing to do.
  if (platform !== 'win32') return { command, args, options: {} };

  // A real executable can be spawned directly; no shell means no quoting problem.
  if (!/\.(bat|cmd)$/i.test(command)) return { command, args, options: {} };

  const line = [escapeCommand(command), ...args.map(a => escapeArgument(a, true))].join(' ');
  return {
    command: comspec || process.env.ComSpec || 'cmd.exe',
    // /d skips AutoRun scripts, /s makes cmd strip exactly the outer quote pair.
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * Convenience wrapper: resolve `name` on PATH, then project it. Falls back to the plain
 * name (spawned via the shell) when resolution fails, so a missing binary still produces
 * the normal "not found" error rather than a confusing one from here.
 */
export function prepareSpawn(name, args, { env = process.env, platform = process.platform } = {}) {
  const resolved = resolveCommand(name, { env, platform });
  if (!resolved) return { command: name, args, options: platform === 'win32' ? { shell: true } : {} };
  return buildSpawn({ command: resolved, args, platform, comspec: env.ComSpec });
}
