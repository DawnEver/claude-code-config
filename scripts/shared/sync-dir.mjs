// scripts/shared/sync-dir.mjs — where the cloud-synced config payload lives.
//
// The working tree and `.git` must NEVER sit inside a file-sync folder: a sync daemon
// replicating `.git/` from another host corrupts the index and overwrites the reflog
// (see docs/sync-architecture.md § 1). But a few hand-written config files DO need to
// reach every machine. Those three — claude_settings.json, claude_env_settings.json,
// codex_config.toml — are the "sync payload", and this module answers the only
// question the rest of the codebase asks about it: which directory holds it.
//
// Resolution order:
//   1. $CLAUDE_SYNC_DIR      — explicit override (tests, CI, unusual layouts)
//   2. ~/.claude/sync-dir    — machine-local pointer file, one line holding a path.
//                              Not an env var, so it also works for GUI-launched apps
//                              and non-login shells.
//   3. the repo root         — zero-config default. No cloud storage required; the
//                              layout collapses to exactly the pre-syncDir behaviour.
//
// There is deliberately NO OneDrive auto-detection. Not every user of this repo has
// OneDrive (or wants their config in it), several accounts may be mounted at once, and
// Dropbox/iCloud/Syncthing are equally valid backing stores. The pointer file makes the
// choice explicit and auditable at the cost of one command per machine.
//
// Only setup.js and the two launchers resolve this. Everything else reaches the payload
// through the `~/.claude/...` and `~/.codex/...` links setup creates — the same
// convention that keeps absolute cloud paths out of every shared file (see
// .claude/memory/2026/08/11/system-prompt-paths-symlink.md).

import fs from 'fs';
import path from 'path';
import os from 'os';

export const SYNC_DIR_POINTER_NAME = 'sync-dir';

/** Files that live in the sync payload rather than the repo. */
export const SYNC_PAYLOAD_FILES = [
  'claude_settings.json',
  'claude_env_settings.json',
  'codex_config.toml',
];

/**
 * Expand a leading `~/` (or a bare `~`) against `home`.
 * `~user/...` is another account's home and is left untouched — expanding it against
 * our own home would silently point at the wrong place.
 */
export function expandTilde(p, home = os.homedir()) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

function pointerPath(home) {
  return path.join(home, '.claude', SYNC_DIR_POINTER_NAME);
}

/**
 * Read the machine-local sync-dir pointer.
 * @returns {string|null} the trimmed path, or null when absent/blank.
 */
export function readSyncDirPointer(home = os.homedir()) {
  try {
    const body = fs.readFileSync(pointerPath(home), 'utf8').trim();
    return body || null;
  } catch {
    return null;
  }
}

/**
 * Write the machine-local sync-dir pointer, creating `~/.claude` if setup has not
 * populated it yet (the pointer is read before links are created).
 */
export function writeSyncDirPointer(dir, home = os.homedir()) {
  const target = pointerPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${String(dir).trim()}\n`);
  return target;
}

/**
 * Resolve the directory holding the sync payload.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot  Fallback when nothing is configured.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.home]
 * @returns {string}
 */
export function resolveSyncDir({ repoRoot, env = process.env, home = os.homedir() } = {}) {
  // A blank-but-exported env var is a common shell-profile accident; treat it as unset
  // rather than letting '' resolve to the cwd.
  const fromEnv = (env.CLAUDE_SYNC_DIR || '').trim();
  if (fromEnv) return expandTilde(fromEnv, home);

  const fromPointer = readSyncDirPointer(home);
  if (fromPointer) return expandTilde(fromPointer, home);

  return repoRoot;
}

/**
 * Describe how the sync dir was chosen, for setup's startup banner — a mis-set pointer
 * should be visible, not silent.
 */
export function syncDirSource({ env = process.env, home = os.homedir() } = {}) {
  if ((env.CLAUDE_SYNC_DIR || '').trim()) return 'CLAUDE_SYNC_DIR';
  if (readSyncDirPointer(home)) return `~/.claude/${SYNC_DIR_POINTER_NAME}`;
  return 'repo (no sync dir configured)';
}

/**
 * Check a configured sync dir before anything is written to it.
 *
 * A pointer is never validated on read, and setup used to `mkdir -p` whatever it named —
 * so a typo'd, renamed or not-yet-mounted path silently became a brand-new EMPTY config
 * dir, and the host came up on template config having apparently succeeded. Creating the
 * directory is only ever correct on the explicit `--sync-dir` path.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateSyncDir(syncDir, { repoRoot, env = process.env, home = os.homedir() } = {}) {
  if (repoRoot && path.resolve(syncDir) === path.resolve(repoRoot)) return { ok: true };

  const source = syncDirSource({ env, home });
  if (!fs.existsSync(syncDir)) {
    return {
      ok: false,
      reason: `sync dir does not exist: ${syncDir}\n`
        + `      (configured via ${source})\n`
        + '      If the path is wrong, fix or delete ~/.claude/sync-dir.\n'
        + '      If the cloud folder is not mounted yet, wait — do NOT let setup create it.',
    };
  }
  if (!fs.statSync(syncDir).isDirectory()) {
    return { ok: false, reason: `sync dir is not a directory: ${syncDir}` };
  }
  return { ok: true };
}
