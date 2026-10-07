// scripts/shared/seats.mjs — Claude seats: one (account, team) login = one config dir.
//
// A seat is declared once, in the top-level `seats` of claude_env_settings.json (sync
// payload, never in git — it names accounts):
//   seats: [{alias, email, org?, orgUuid?, machines: [<machine>], claimed?: [<offer id>]}]
// `alias` (lowercase, e.g. `team-a`) names the seat on a machine, so it is unique per
// machine; the same alias may name different accounts' seats on different machines.
//
// Layers: `~/.claude` is the machine's base dir — code, machine files, the IDE and plain
// `ccc` (whatever login it holds). A seat with an alias lives in `~/.claude-<alias>`, which
// Claude Code uses as CLAUDE_CONFIG_DIR: it owns that seat's login, `.claude.json`,
// transcripts and usage, and links everything else back to the shared config. This file is
// the only place that maps an alias to a directory.

import fs from 'fs';
import os from 'os';
import path from 'path';

const ALIAS = /^[a-z0-9][a-z0-9-]*$/;
export const isValidAlias = (alias) => typeof alias === 'string' && ALIAS.test(alias);

export const baseDir = (home = os.homedir()) => path.join(home, '.claude');
export const seatDir = (alias, home = os.homedir()) => path.join(home, `.claude-${alias}`);

/** The config dir a Claude process with `env` runs in. */
export const configDir = (env = process.env, home = os.homedir()) => env.CLAUDE_CONFIG_DIR || baseDir(home);

/** The seat alias of a config dir, or null for the base dir or any dir not made by seatDir. */
export function aliasOf(dir, home = os.homedir()) {
  const m = path.basename(dir).match(/^\.claude-(.+)$/);
  return m && isValidAlias(m[1]) && path.resolve(dir) === path.resolve(seatDir(m[1], home)) ? m[1] : null;
}

/** Where a dir's `.claude.json` lives: the base dir keeps it in home, a seat inside itself. */
export const accountFile = (dir, home = os.homedir()) =>
  (path.resolve(dir) === path.resolve(baseDir(home)) ? path.join(home, '.claude.json') : path.join(dir, '.claude.json'));

/** Where hud-hook.js tees a dir's statusLine `rate_limits` for the fleet report. */
export const usageFile = (dir) => path.join(dir, 'bridge', 'claude-usage.json');

const norm = (s) => ({ alias: isValidAlias(s.alias) ? s.alias : null, email: s.email ?? null, org: s.org ?? null,
  orgUuid: s.orgUuid ?? null, claimed: Array.isArray(s.claimed) ? s.claimed.map(String) : [] });

/** The seats `machine` holds, normalised; junk entries are skipped. */
export function seatsFor(seats, machine) {
  return (Array.isArray(seats) ? seats : [])
    .filter((s) => s && typeof s === 'object' && Array.isArray(s.machines) && s.machines.includes(machine))
    .map(norm);
}

/** `seats` from the merged claude_env_settings.json (the ~/.claude link), or [] when unreadable. */
export function readSeats(file = path.join(baseDir(), 'claude_env_settings.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).seats ?? []; } catch { return []; }
}
