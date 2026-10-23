import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** One active home per process. Never discover account directories by guessing names. */
export function resolveCodexHome({ env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  let value = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (!value) return path.join(home, '.codex');
  if (value === '~') value = home;
  else if (/^~[\\/]/.test(value)) value = path.join(home, value.slice(2));
  return path.resolve(cwd, value);
}

/** Opaque home scope for local derived cursors/series; never transmit a private path. */
export function codexHomeKey(home = resolveCodexHome()) {
  return createHash('sha256').update(process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home)).digest('hex').slice(0, 16);
}
