// scripts/shared/seats.mjs — Claude seats: one (account, team) login = one config dir.
//
// A seat is declared once, in the top-level `seats` of claude_env_settings.json (sync
// payload, never in git — it names accounts):
//   seats: [{alias, email, org?, orgUuid?, machines: [<machine>], claimed?: [<offer id>]}]
// `alias` (lowercase, e.g. `team-a`) names the seat on a machine, so it is unique per
// machine; the same alias may name different accounts' seats on different machines.
//
// Layers: `~/.claude` is the machine's base dir — code, machine files, the IDE and plain
// `ccc` (whatever login it holds). A seat lives where its login is: in the base dir when the
// base dir's login holds it (one login, never a copied credential), else in
// `~/.claude-<alias>`, which Claude Code uses as CLAUDE_CONFIG_DIR: it owns that seat's login,
// `.claude.json`, transcripts and usage, and links everything else back to the shared config.
// This file is the only place that maps an alias to a directory.

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

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** A dir's `.claude.json` oauthAccount -> {email, org, orgUuid, tier}, or null when not on a subscription login. */
export function readAccount(dir, home = os.homedir()) {
  const a = readJson(accountFile(dir, home))?.oauthAccount;
  return a?.emailAddress ? { email: a.emailAddress, org: a.organizationName ?? null, orgUuid: a.organizationUuid ?? null, tier: a.seatTier ?? null } : null;
}

export const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
// A seat pins its org by `orgUuid` when given (exact), else by `org`: the name as a person
// writes it ("Acme Lab"), a case-insensitive substring of Claude's organizationName
// ("Uni Acme Lab"). Neither given: any org passes.
export const orgOk = (account, seat) => (seat.orgUuid ? account.orgUuid === seat.orgUuid
  : !seat.org || String(account.org ?? '').toLowerCase().includes(String(seat.org).trim().toLowerCase()));
/** Whether `account` is `seat`'s login. */
export const holds = (account, seat) => Boolean(account) && (!seat.email || sameText(account.email, seat.email)) && orgOk(account, seat);

/** The alias of this machine's seat the base dir's login holds, or null. */
export function baseSeat(seats, machine, home = os.homedir()) {
  const account = readAccount(baseDir(home), home);
  return seatsFor(seats, machine).find((s) => s.alias && holds(account, s))?.alias ?? null;
}

/** The config dir seat `alias` runs in on this machine: the base dir when its login holds it. */
export const seatHome = (alias, seats, machine, home = os.homedir()) =>
  (baseSeat(seats, machine, home) === alias ? baseDir(home) : seatDir(alias, home));

/** The seat alias a config dir runs as: a seat dir's own, or the one the base dir's login holds. */
export const seatOf = (dir, seats, machine, home = os.homedir()) => aliasOf(dir, home)
  ?? (path.resolve(dir) === path.resolve(baseDir(home)) ? baseSeat(seats, machine, home) : null);

const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};
const MAX_TYPO = 2;

/**
 * What a typed seat name means among `aliases`: the exact alias, else the one alias it is a
 * prefix of, else the one alias within MAX_TYPO edits. Anything else is an error naming every
 * choice: guessing between seats would run as the wrong account.
 * @returns {{alias: string, match: 'exact'|'prefix'|'typo'}|{error: string}}
 */
export function resolveSeat(input, aliases) {
  const name = String(input ?? '').trim().toLowerCase();
  const choices = aliases.length ? aliases.join(', ') : 'none (add this machine to `seats` in claude_env_settings.json)';
  if (aliases.includes(name)) return { alias: name, match: 'exact' };
  const prefixed = name ? aliases.filter((a) => a.startsWith(name)) : [];
  if (prefixed.length === 1) return { alias: prefixed[0], match: 'prefix' };
  const near = name ? aliases.map((a) => [a, distance(name, a)]).filter(([, d]) => d <= MAX_TYPO).sort((x, y) => x[1] - y[1]) : [];
  if (near.length && (near.length === 1 || near[0][1] < near[1][1])) return { alias: near[0][0], match: 'typo' };
  return { error: `unknown seat ${JSON.stringify(input ?? '')}; seats on this machine: ${choices}` };
}

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
