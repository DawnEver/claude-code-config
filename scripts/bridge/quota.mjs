// scripts/bridge/quota.mjs — this machine's quota per account, as data for the dashboard
// (docs/dashboard.md "Quota"). Every input is an observation this machine already has:
//   - Claude quota and account, per local config dir (the base dir and each seat dir, see
//     scripts/shared/seats.mjs): the statusLine payload's `rate_limits`, teed by hud-hook.js
//     into the series <dir>/bridge/claude-usage.jsonl (only fresh while a session there
//     renders), and the dir's `.claude.json` `oauthAccount` (email + organization).
//   - Codex quota: the shared app-server's `account/rateLimits` (codex-adapter.mjs), recorded
//     on every read into the bridge runtime's codex-usage.jsonl series.
//   - Expected seats: top-level `seats` of claude_env_settings.json, re-read every read.
// A series (quota-series.mjs) holds each window's samples while it is current; its last
// sample is the quota now, the rest say where in the window it was spent (the trend).
// One forecast per window (project): the current speed carried to the reset. A stale reading
// is never projected from. Rendering, pace and countdowns belong to the reader
// (scripts/dashboard/public/view.mjs): they depend only on its clock.

import fs from 'fs';
import os from 'os';
import { readBridgeConfig } from './context.mjs';
import { fetchExtraResets } from './extra-resets.mjs';
import { burn, readSeries, recordSample } from './quota-series.mjs';
import { QUOTA_STALE_MS } from '../dashboard/public/shared/vocab.mjs';
import { baseDir, holds, orgOk, readAccount, readSeats, sameText, seatDir, seatsFor, usageFile } from '../shared/seats.mjs';

const H = 3600000;
const CLAUDE_WINDOWS = { five_hour: 5 * H, seven_day: 168 * H };
// Too early in a window the average pace is noise; do not project from it.
const MIN_ELAPSED_FRACTION = 0.1;

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
/** A window's label from its length: 5h, 7d. */
const span = (ms) => (ms < 24 * H ? `${Math.round(ms / H)}h` : `${Math.round(ms / (24 * H))}d`);

/**
 * One quota window as observed at `at` (epoch ms, like `resetsAt`). `perHour`: the average
 * % per hour since the window opened, null too early in it to mean anything.
 * @returns {{used, resetsAt, windowMs, perHour}|null}
 */
export function windowView({ used, resetsAt, windowMs, at }) {
  used = pct(used);
  if (used === null || !(resetsAt > at) || !(windowMs > 0)) return null;
  const elapsed = windowMs - (resetsAt - at);
  const early = elapsed < windowMs * MIN_ELAPSED_FRACTION;
  return { used, resetsAt, windowMs, perHour: early ? null : used / elapsed * H };
}

/**
 * The one forecast of a window: where its use goes if spending keeps its current speed.
 * Speed is the last observed trend cell's (`recent`, % per hour), else the average since the
 * window opened. No forecast from a stale reading, or too early in the window (`perHour`
 * null), or for an exhausted window (it says so itself).
 * @returns {{rate, atReset, eta, short}|null} rate % per hour; atReset: use at the reset
 *   (may exceed 100); eta: when it reaches 100%, null if never; short: eta before the reset
 */
export function project(v, { recent = null, now, fresh }) {
  if (!fresh || v.used >= 100 || v.perHour == null || !(v.resetsAt > now)) return null;
  const rate = recent ?? v.perHour;
  const eta = rate > 0 ? now + (100 - v.used) / rate * H : null;
  return { rate, atReset: v.used + rate * (v.resetsAt - now) / H, eta, short: eta != null && eta < v.resetsAt };
}

/** statusLine `rate_limits` ({five_hour:{used_percentage, resets_at(sec)}, seven_day}) -> windows. */
export function claudeWindows(rl) {
  const windows = {};
  for (const [name, windowMs] of Object.entries(CLAUDE_WINDOWS)) {
    const w = rl?.[name];
    if (w && pct(w.used_percentage) !== null && w.resets_at > 0) windows[span(windowMs)] = { used: pct(w.used_percentage), resetsAt: w.resets_at * 1000, windowMs };
  }
  return windows;
}

/** Codex `account/rateLimits` ({primary, secondary}) -> windows. */
export function codexWindows(limits) {
  const windows = {};
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!(w?.windowDurationMins > 0) || pct(w.usedPercent) === null || !(w.resetsAt > 0)) continue;
    const windowMs = w.windowDurationMins * 60000;
    windows[span(windowMs)] = { used: pct(w.usedPercent), resetsAt: w.resetsAt * 1000, windowMs };
  }
  return windows;
}

/**
 * An account's quota from its series (quota-series.mjs): the last sample's windows as views,
 * with the series kept for the trend. Null when there is nothing current to show.
 */
export function quotaOf(series) {
  const last = series?.at(-1);
  if (!last) return null;
  const windows = {};
  for (const [k, w] of Object.entries(last.windows)) {
    const v = windowView({ ...w, at: last.at });
    if (v) windows[k] = v;
  }
  return Object.keys(windows).length ? { at: last.at, windows, series } : null;
}

/**
 * Whether this host records quota at all: only the dashboard reads the series, so a host
 * without a configured dashboard (bridge.dashboard, docs/dashboard.md) writes nothing.
 */
export function recordsQuota(paths) {
  try { return readBridgeConfig(paths).dashboard !== null; } catch { return false; }
}

/** hud-hook.js side: record the statusLine's quota into this config dir's series. Fail-silent. */
export function teeClaudeUsage(statusLine, { file, now = Date.now() } = {}) {
  return recordSample(file, claudeWindows(statusLine?.rate_limits), now);
}

/**
 * Every local Claude config dir as {alias, account, quota}: the base dir first (alias null),
 * then each of this machine's seats that has its dir.
 */
export function readClaudeDirs(seats, machine, home = os.homedir()) {
  const dirs = [{ alias: null, dir: baseDir(home) }, ...seatsFor(seats, machine).filter((x) => x.alias)
    .map((x) => ({ alias: x.alias, dir: seatDir(x.alias, home) })).filter((x) => fs.existsSync(x.dir))];
  return dirs.map(({ alias, dir }) => ({ alias, account: readAccount(dir, home), quota: quotaOf(readSeries(usageFile(dir))) }));
}

// About as fine as a phone shows: 5h -> 10 cells of 30 min, 7d -> 14 of 12h.
const cellsFor = (windowMs) => Math.max(1, Math.round(windowMs / (windowMs <= 24 * H ? 30 * 60000 : 12 * H)));

/**
 * Every window of `q`, computed once: its use, reset, trend cells (spend per slice against an
 * even spend; -1 never observed, null still ahead) and forecast. A passed reset is a new window
 * not yet started: no use, no reset time.
 */
function windowModels(q, now) {
  const fresh = q && now - q.at <= QUOTA_STALE_MS;
  return Object.entries(q?.windows ?? {}).map(([k, v]) => {
    if (v.resetsAt <= now) return { k, used: 0, resetsAt: null, windowMs: v.windowMs, cells: [], forecast: null };
    const b = burn(q.series ?? [], k, { now, cells: cellsFor(v.windowMs), seenUntil: fresh ? now : q.at });
    const p = project(v, { recent: b?.now ?? null, now, fresh });
    return { k, used: v.used, resetsAt: v.resetsAt, windowMs: v.windowMs,
      cells: (b?.cells ?? []).map((c) => (c === undefined ? -1 : c)),
      forecast: p ? { atReset: p.atReset, eta: p.eta, short: p.short } : null };
  });
}

// Codex plan ids and Claude seat tiers are wire ids; show the name each is sold under.
// Unlisted ids are title-cased (`edu_plus` -> `Edu Plus`).
const PLAN_NAMES = { self_serve_business_prolite: 'Business Premium', team_labs_premium: 'Team Premium', team_labs_standard: 'Team Standard' };
export const planName = (id) => PLAN_NAMES[id] ?? String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** An account's key, the same everywhere it is stored (the dashboard's quota, the usage store's turns). */
export const claudeAccountKey = (account, fallback) => `claude:${(account?.email ?? fallback).toLowerCase()}|${account?.orgUuid ?? account?.org ?? ''}`;
export const codexAccountKey = (email, fallback) => `codex:${(email ?? fallback).toLowerCase()}`;

const who = (email, org) => [email, org].filter(Boolean).join(' · ') || 'not logged in';

/** What is wrong with `account` sitting in `seat`'s place, or null. */
function seatProblem(account, seat) {
  const expected = who(seat.email, seat.org ?? seat.orgUuid);
  return !account ? `no subscription login, expected ${expected}`
    : seat.email && !sameText(account.email, seat.email) ? `wrong account, expected ${expected}`
    : !orgOk(account, seat) ? `wrong team, expected ${expected}` : null;
}

/**
 * Local config dirs grouped by the seat they hold, in registry order. A seat dir holds its
 * alias's seat. The base dir holds the seat its login matches; on a one-seat machine it is
 * that seat whatever its login (so a wrong login is reported); otherwise it is unassigned.
 * Two dirs on one seat (the base logged into a seat that also has its own dir) merge: the
 * freshest quota wins.
 */
function claudeGroups(dirs, seats, machine) {
  const mine = seatsFor(seats, machine);
  const groups = new Map();
  // A seat dir that never logged in is not a problem when another dir already holds its seat.
  const held = (seat) => dirs.some((o) => holds(o.account, seat));
  for (const d of dirs) {
    const seat = d.alias ? mine.find((x) => x.alias === d.alias) ?? null
      : mine.find((x) => holds(d.account, x)) ?? (mine.length === 1 ? mine[0] : null);
    const problem = d.alias && !seat ? `seat ${d.alias} is not registered for ${machine}`
      : !d.alias && !mine.length && Array.isArray(seats) && seats.length ? `${machine} is not in seats`
      : seat && !(d.alias && !d.account && held(seat)) ? seatProblem(d.account, seat) : null;
    const key = seat ? mine.indexOf(seat) : `dir:${d.alias ?? ''}`;
    const g = groups.get(key) ?? { seat, label: seat?.alias ?? d.alias, account: d.account, quota: null, problems: [], aliases: [] };
    if (d.alias) g.account = d.account;
    if (d.quota && !(g.quota?.at >= d.quota.at)) g.quota = d.quota;
    if (problem && !g.problems.includes(problem)) g.problems.push(problem);
    g.aliases.push(d.alias);
    groups.set(key, g);
  }
  // Unassigned dirs first, then seats in registry order.
  return [...groups.entries()].sort(([a], [b]) => (typeof a === 'number' ? a : -1) - (typeof b === 'number' ? b : -1)).map(([, g]) => g);
}

/**
 * This machine's accounts as data (scripts/shared/dashboard-schema.mjs): every account with
 * quota data or a seat problem. `key` (agent + email + org) lets the dashboard merge one
 * account reported by several hosts. Times are epoch ms.
 */
export function accountModels({ machine, seats, codexAccount, claude = [], codex, codexResetCredits = null, extra = null, now }) {
  const scheduled = (s) => (s ? { at: s.at ?? null, url: s.url ?? null } : null);
  const out = [];
  for (const g of claudeGroups(claude, seats, machine)) {
    if (!g.quota && !g.problems.length) continue;
    const email = g.account?.email ?? null;
    out.push({ key: claudeAccountKey(g.account, `${machine}/${g.label ?? 'base'}`),
      agent: 'claude', label: g.label ?? null, email, aliases: g.aliases,
      detail: [g.account?.org, g.account?.tier && planName(g.account.tier)].filter(Boolean).join(' · ') || null,
      problems: g.problems, at: g.quota?.at ?? null, windows: windowModels(g.quota, now), resetCredits: null,
      extraReset: scheduled(extra?.Claude?.scheduled) });
  }
  if (codex || codexAccount) {
    const expiries = (Array.isArray(codexResetCredits?.credits) ? codexResetCredits.credits : [])
      .map((c) => (c?.expiresAt > 0 ? c.expiresAt * 1000 : null)).filter((x) => x === null || x > now);
    out.push({ key: codexAccountKey(codexAccount?.email, machine), agent: 'codex', label: null,
      email: codexAccount?.email ?? null, detail: codexAccount?.plan ? planName(codexAccount.plan) : null, problems: [],
      at: codex?.at ?? null, windows: windowModels(codex, now),
      resetCredits: codexResetCredits?.availableCount > 0 ? { count: codexResetCredits.availableCount, expiries } : null,
      extraReset: scheduled(extra?.Codex?.scheduled) });
  }
  return out;
}

/**
 * The account a session of this machine spends: a Claude session by the config dir it runs in
 * (`seat`: its alias, null for the base dir), a Codex session by the shared app-server's one
 * account. `aliases` is local knowledge only: the dashboard schema never forwards it.
 */
export function accountFor(session, accounts) {
  const a = session.agent === 'claude' ? accounts.find((x) => x.agent === 'claude' && x.aliases?.includes(session.seat ?? null))
    : accounts.find((x) => x.agent === session.agent);
  return a?.key ?? null;
}

/**
 * Reads this machine's accounts for the dashboard push: Claude config dirs, the Codex series
 * (recorded here, on every read), and the community extra-reset APIs at most every
 * `extraEveryMs` (the push runs every few seconds), refreshed in the background.
 */
export class AccountReader {
  constructor({ machine, codexQuota = () => null, codexAccount = () => null, codexSeriesFile = null, log = () => {}, now = Date.now,
    extraResets = () => fetchExtraResets({ log }), extraEveryMs = 30 * 60000,
    sources = { seats: () => readSeats(), claude: readClaudeDirs } }) {
    Object.assign(this, { machine, codexQuota, codexAccount, codexSeriesFile, now, extraResets, extraEveryMs, sources });
    this.extra = { at: -Infinity, value: null, pending: null };
  }

  /** Synchronous for the push: the extra-reset fetch refreshes in the background. */
  read() {
    const now = this.now();
    if (now - this.extra.at >= this.extraEveryMs && !this.extra.pending) {
      this.extra.pending = this.extraResets().then((v) => { this.extra.value = v; }, () => {})
        .finally(() => { this.extra.at = this.now(); this.extra.pending = null; });
    }
    const cx = this.codexQuota();
    if (cx && this.codexSeriesFile) recordSample(this.codexSeriesFile, codexWindows(cx.limits), cx.at);
    const seats = this.sources.seats();
    const codex = cx ? quotaOf(this.codexSeriesFile ? readSeries(this.codexSeriesFile) : [{ from: cx.at, at: cx.at, windows: codexWindows(cx.limits) }]) : null;
    return accountModels({ machine: this.machine, seats, codexAccount: this.codexAccount(), codexResetCredits: cx?.resetCredits ?? null,
      claude: this.sources.claude(seats, this.machine), codex, extra: this.extra.value, now });
  }
}
