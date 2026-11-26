// host-binary.mjs - where a host CLI (claude, codex, agy) lives, independent of the calling shell.
//
// Setup and the launchers used to ask only the PATH the running process inherited. A shell opened
// before an installer extended the user PATH does not see the new dir, so setup skipped `agyc`
// although agy was installed (user ruling 2026-11-26: setup's result must not depend on the shell).
// One resolver, searched in order:
//   1. the process PATH;
//   2. on Windows, the user then machine PATH from the registry, variables expanded;
//   3. the host's documented standard install dirs (STANDARD_DIRS).

import { execFileSync } from 'child_process';
import path from 'path';
import { resolveCommand } from '../runtime/win-spawn.mjs';

const USER_KEY = String.raw`HKCU\Environment`;
const MACHINE_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`;

/**
 * Documented standard install dirs, per platform, only where evidence names them:
 * agy on Windows installs into %LOCALAPPDATA%\agy\bin; Claude Code's native installer uses
 * ~/.local/bin (docs/setup.md). codex (npm global) has no fixed dir and so none here.
 */
export const STANDARD_DIRS = {
  win32: { agy: [String.raw`%LOCALAPPDATA%\agy\bin`], claude: [String.raw`%USERPROFILE%\.local\bin`] },
  posix: { claude: ['$HOME/.local/bin'] },
};

const envGet = (env, name) => env[Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())];
const expand = (s, env) => String(s || '')
  .replace(/%([^%]+)%/g, (m, v) => envGet(env, v) ?? m)
  .replace(/\$(\w+)/g, (m, v) => env[v] ?? m);

function queryRegistryPath(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'Path'], { stdio: 'pipe', windowsHide: true }).toString();
    const line = out.split(/\r?\n/).find((l) => /^\s+Path\s+REG_/i.test(l));
    return line ? line.replace(/^\s+Path\s+REG_\w+\s+/i, '').trim() : '';
  } catch { return ''; }
}

/** The raw (unexpanded) user and machine PATH from the Windows registry. */
export const readRegistryPaths = () => ({ user: queryRegistryPath(USER_KEY), machine: queryRegistryPath(MACHINE_KEY) });

/**
 * @returns {{ path: string, source: string, searched: string[] } | { path: null, searched: string[], error: string }}
 */
export function resolveHostBinary(name, { env = process.env, platform = process.platform, registryPaths = readRegistryPaths } = {}) {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const split = (s) => expand(s, env).split(sep).map((d) => d.trim()).filter(Boolean);
  const places = [['process PATH', split(envGet(env, 'PATH'))]];
  if (win) {
    const reg = registryPaths();
    places.push(['registry user PATH', split(reg.user)], ['registry machine PATH', split(reg.machine)]);
  }
  places.push(['standard dir', (STANDARD_DIRS[win ? 'win32' : 'posix'][name] || []).map((d) => expand(d, env))]);
  const searched = [];
  for (const [source, dirs] of places) {
    for (const dir of dirs) {
      searched.push(`${source}: ${dir}`);
      const found = resolveCommand(name, { env: { PATH: dir, PATHEXT: envGet(env, 'PATHEXT') }, platform });
      if (found) return { path: found, source, searched };
    }
  }
  return { path: null, searched, error: `${name} not found; searched ${searched.join('; ') || '(no dirs)'}` };
}

/** `env` with the resolved host's dir first on PATH when the inherited PATH lacks it, so a child finds it. */
export function envWithHostOnPath(name, env = process.env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const found = resolveHostBinary(name, { env, ...opts, platform });
  if (!found.path || found.source === 'process PATH') return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  return { ...env, [key]: [path.dirname(found.path), env[key]].filter(Boolean).join(sep) };
}
