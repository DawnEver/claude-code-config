// scripts/shared/own-python.mjs -- the ONE interpreter every Python door cc-config calls runs under: this
// checkout's own environment (pyproject.toml [dependency-groups] doors, pinned by uv.lock). Derived from where
// these scripts live, never recorded and never borrowed from another repo's environment. setup builds it.

import path from 'path';
import { fileURLToPath } from 'url';

/** The cc-config checkout these scripts belong to. */
export const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `<root>/.venv`'s interpreter in the platform's layout. */
export function ownPython({ root = OWN_ROOT, platform = process.platform } = {}) {
  return platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
}
