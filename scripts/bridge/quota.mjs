// scripts/bridge/quota.mjs — this machine's quota per account, as data for the dashboard
// (docs/dashboard.md "Quota"). Every input is an observation this machine already has:
//   - Claude quota and account, per local config dir (the base dir and each seat dir, see
//     scripts/shared/seats.mjs): the statusLine payload's `rate_limits`, teed by hud-hook.js
//     into the series <dir>/bridge/claude-usage.jsonl (only fresh while a session there
//     renders), and the dir's `.claude.json` `oauthAccount` (email + organization).
//   - Codex quota: the shared app-server's `account/rateLimits` (codex-adapter.mjs), recorded
//     on every read into the bridge runtime's codex-usage.jsonl series.
//   - Antigravity (agy) quota: its statusLine payload's `quota` ({<pool>-<span>: {remaining_fraction,
//     reset_in_seconds | resets_at}}), teed by scripts/hooks/agy-statusline.mjs into one series per
//     pool (agy-usage-<account>-<pool>.jsonl in the bridge runtime); the account is the login agy
//     logs (cli.log `applyAuthResult: email=`). Each pool is its own account entry.
//   - Expected seats: top-level `seats` of claude_env_settings.json, re-read every read.
// A series (quota-series.mjs) holds each window's samples while it is current; its last
// sample is the quota now, the rest say where in the window it was spent (the trend).
// One forecast per window (project): the current speed carried to the reset. A stale reading
// is never projected from. Rendering, pace and countdowns belong to the reader
// (scripts/dashboard/public/view.mjs): they depend only on its clock.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { resolveHostBinary } from '../shared/host-binary.mjs';
import { BRIDGE_RUNTIME_DIR } from './runtime-paths.mjs';
import { readBridgeConfig } from './context.mjs';
import { balanceKeyFor } from './balances.mjs';
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
 * not yet started: no use, no reset time. Shortest window first (5h before 7d) for every agent:
 * the order a source sampled them in (Antigravity reports the weekly bucket first) is not a display order.
 */
function windowModels(q, now) {
  const fresh = q && now - q.at <= QUOTA_STALE_MS;
  return Object.entries(q?.windows ?? {}).sort(([, a], [, b]) => a.windowMs - b.windowMs).map(([k, v]) => {
    if (v.resetsAt <= now) return { k, used: 0, resetsAt: null, windowMs: v.windowMs, cells: [], forecast: null };
    // A fresh reading is the model's clock: trend and forecast move with a new reading, not with the time, so an
    // unchanged reading pushes an unchanged snapshot (dashboard-push.mjs skips it). A stale one is observed up to
    // its last sample and only its not-yet-reached cells advance with the time.
    const b = burn(q.series ?? [], k, { now: fresh ? q.at : now, cells: cellsFor(v.windowMs), seenUntil: q.at });
    const p = project(v, { recent: b?.now ?? null, now: q.at, fresh });
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
/** An Antigravity login's key (the usage store's turns); its quota pools add `|<pool>` (accountModels). */
export const agyAccountKey = (email, fallback) => `agy:${(email ?? fallback).toLowerCase()}`;

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
/**
 * `codex`: one entry per Codex home ({label, account, quota, resetCredits, fallback}): its
 * label (null for the base home) becomes an alias of its account, so a session finds it by its
 * home as a Claude session finds its seat; two homes on one login merge into one account.
 */
export function accountModels({ machine, seats, claude = [], codex = [], agy = [], agyEmail = null, extra = null, now }) {
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
  const codexByKey = new Map();
  for (const h of codex) {
    if (!h.quota && !h.account) continue;
    const key = codexAccountKey(h.account?.email, h.fallback ?? machine);
    const held = codexByKey.get(key);
    if (held) { held.aliases.push(h.label ?? null); if (h.quota && !(held.at >= h.quota.at)) Object.assign(held, { at: h.quota.at, windows: windowModels(h.quota, now) }); continue; }
    const expiries = (Array.isArray(h.resetCredits?.credits) ? h.resetCredits.credits : [])
      .map((c) => (c?.expiresAt > 0 ? c.expiresAt * 1000 : null)).filter((x) => x === null || x > now);
    const a = { key, agent: 'codex', label: h.label ?? null, email: h.account?.email ?? null, aliases: [h.label ?? null],
      detail: h.account?.plan ? planName(h.account.plan) : null, problems: [],
      at: h.quota?.at ?? null, windows: windowModels(h.quota, now),
      resetCredits: h.resetCredits?.availableCount > 0 ? { count: h.resetCredits.availableCount, expiries } : null,
      extraReset: scheduled(extra?.Codex?.scheduled) };
    codexByKey.set(key, a);
    out.push(a);
  }
  // Antigravity: one entry per quota pool of its login; when logged in before the first statusLine
  // sample lands, still surface the authenticated account (windows: []) like Claude/Codex seats.
  const liveAgy = agy.filter((p) => p.quota);
  if (liveAgy.length) {
    liveAgy.forEach((p, i) => {
      out.push({ key: `agy:${(p.account?.email ?? machine).toLowerCase()}|${p.pool}`, agent: 'agy', label: p.pool, email: p.account?.email ?? null,
        aliases: i === 0 ? [null] : [], detail: p.detail ?? null, problems: [], at: p.quota.at, windows: windowModels(p.quota, now), resetCredits: null, extraReset: null });
    });
  } else if (agyEmail) {
    out.push({ key: `agy:${agyEmail.toLowerCase()}`, agent: 'agy', label: null, email: agyEmail,
      aliases: [null], detail: null, problems: [], at: null, windows: [], resetCredits: null, extraReset: null });
  }
  return out;
}

/**
 * The account a session of this machine spends: a Claude session by the config dir it runs in
 * (`seat`: its alias, null for the base dir), a Codex session by the Codex home it runs in
 * (`seat`: the home's label, null for the base home: codex-home.mjs), an API-key session (ccds, cods: `provider`) by its platform's configured balance
 * entry (`bridge.balances`) — never the subscription beside it, and whether or not this host can
 * read that balance. `aliases` is local knowledge only: the dashboard schema never forwards it.
 */
export function accountFor(session, accounts, balanceEntries = []) {
  if (session.provider) return balanceKeyFor(session.provider, balanceEntries);
  const a = accounts.find((x) => x.agent === session.agent && x.aliases?.includes(session.seat ?? null));
  return a?.key ?? null;
}

/**
 * Reads this machine's accounts for the dashboard push: Claude config dirs, each Codex home's
 * series (recorded here, on every read), and the community extra-reset APIs at most every
 * `extraEveryMs` (the push runs every few seconds), refreshed in the background.
 * `codex()`: each Codex home's {home, label, quota, account} (codex-adapter.mjs CodexHomes);
 * `codexSeriesFile(home, account)` and `codexFallback(home)` scope its series and unknown account.
 */
export class AccountReader {
  constructor({ machine, codex = () => [], codexSeriesFile = null, codexFallback = () => machine, log = () => {}, now = Date.now,
    extraResets = () => fetchExtraResets({ log }), extraEveryMs = 30 * 60000, agyEveryMs = 10 * 60000,
    agyRefresh = undefined,
    sources }) {
    const defaultSources = !sources;
    sources ??= { seats: () => readSeats(), claude: readClaudeDirs, agy: () => readAgy(), agyEmail: () => readAgyEmail() };
    Object.assign(this, { machine, codex, codexSeriesFile, codexFallback, now, extraResets, extraEveryMs, agyEveryMs, sources });
    this.agyRefresh = agyRefresh !== undefined ? agyRefresh : (defaultSources ? () => refreshAgyQuota({ now: this.now }) : null);
    this.extra = { at: -Infinity, value: null, pending: null };
    this.agyPoll = { at: -Infinity, pending: null };
  }

  /** Synchronous for the push: the extra-reset and agy `/quota` fetches refresh in the background. */
  read() {
    const now = this.now();
    if (now - this.extra.at >= this.extraEveryMs && !this.extra.pending) {
      this.extra.pending = this.extraResets().then((v) => { this.extra.value = v; }, () => {})
        .finally(() => { this.extra.at = this.now(); this.extra.pending = null; });
    }
    if (this.agyRefresh && now - this.agyPoll.at >= this.agyEveryMs && !this.agyPoll.pending) {
      this.agyPoll.pending = this.agyRefresh().catch(() => {})
        .finally(() => { this.agyPoll.at = this.now(); this.agyPoll.pending = null; });
    }
    const codex = this.codex().map(({ home, label, quota: cx, account }) => {
      const seriesFile = this.codexSeriesFile?.(home, account) ?? null;
      if (cx && seriesFile) recordSample(seriesFile, codexWindows(cx.limits), cx.at);
      const quota = cx ? quotaOf(seriesFile ? readSeries(seriesFile) : [{ from: cx.at, at: cx.at, windows: codexWindows(cx.limits) }]) : null;
      return { label, account, quota, resetCredits: cx?.resetCredits ?? null, fallback: this.codexFallback(home) };
    });
    const seats = this.sources.seats();
    const agyList = this.sources.agy?.() ?? [];
    const agyEmail = agyList.length ? null : (this.sources.agyEmail?.() ?? null);
    return accountModels({ machine: this.machine, seats, codex, claude: this.sources.claude(seats, this.machine), agy: agyList, agyEmail, extra: this.extra.value, now });
  }
}

// ── Antigravity (agy) ──

/** agy's own state dir (cli.log, brain/, settings.json). */
export const AGY_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const AGY_STATUSLINE_LAST = 'agy-statusline-last.json';
const AGY_POOL = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const AGY_SPANS = { daily: 24 * H, day: 24 * H, weekly: 168 * H, week: 168 * H };
// Map agy's internal 3p pool slug (`3p-weekly`, `3p-5h`: "Claude and GPT models") to a clear label.
const AGY_POOL_LABELS = { '3p': 'claude-gpt' };

/** A quota bucket id -> {pool, windowMs}: `gemini-5h` -> gemini 5h, `3p-weekly` -> claude-gpt 7d; null when it names no span. */
export function agyTier(name, explicitWindow = null) {
  const raw = String(name ?? '').trim();
  if (explicitWindow) {
    const w = /^(?:(\d{1,3})\s*([hd])|(daily|day|weekly|week))$/i.exec(String(explicitWindow).trim());
    if (w) {
      const windowMs = w[1] ? Number(w[1]) * (w[2].toLowerCase() === 'h' ? H : 24 * H) : AGY_SPANS[w[3].toLowerCase()];
      const base = raw.replace(/[-_ ](?:\d{1,3}\s*[hd]|daily|day|weekly|week)$/i, '') || 'agy';
      const pool = AGY_POOL_LABELS[base.toLowerCase()] ?? base.toLowerCase();
      if (windowMs > 0 && AGY_POOL.test(pool)) return { pool, windowMs };
    }
  }
  const m = /^(.*?)[-_ ]?(?:(\d{1,3})\s*([hd])|(daily|day|weekly|week))$/i.exec(raw);
  if (!m) return null;
  const windowMs = m[2] ? Number(m[2]) * (m[3].toLowerCase() === 'h' ? H : 24 * H) : AGY_SPANS[m[4].toLowerCase()];
  const rawPool = (m[1] || 'agy').toLowerCase();
  const pool = AGY_POOL_LABELS[rawPool] ?? rawPool;
  return windowMs > 0 && AGY_POOL.test(pool) ? { pool, windowMs } : null;
}

function parseResetMs(q, now) {
  if (typeof q?.reset_time === 'string' && q.reset_time.trim()) {
    const ms = Date.parse(q.reset_time);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  if (typeof q?.reset_time === 'number' && Number.isFinite(q.reset_time) && q.reset_time > 0) {
    return q.reset_time < 1e12 ? q.reset_time * 1000 : q.reset_time;
  }
  if (Number.isFinite(q?.reset_in_seconds) && q.reset_in_seconds >= 0) return now + q.reset_in_seconds * 1000;
  return null;
}

/**
 * Parse Antigravity's two measured quota contracts into `{<pool>: {<span>: {used, resetsAt, windowMs}}}`:
 *   1. `agy -p /quota --output-format json` -> `payload.command.data.groups[*].buckets[*]`
 *      (`{id, window, remaining_fraction, reset_time}`)
 *   2. `statusLine` (`telemetry: true`) -> `payload.quota` (`map[string]StatusLineQuotaBucket`
 *      with `remaining_fraction` or `used_percentage`, and `reset_time` or `reset_in_seconds`).
 */
export function agyPools(input, now = Date.now()) {
  const pools = {};
  if (!input || typeof input !== 'object') return pools;
  const groups = input?.command?.data?.groups;
  const entries = Array.isArray(groups)
    ? groups.flatMap((g) => (Array.isArray(g?.buckets) ? g.buckets : []).map((b) => [b?.id ?? '', b, b?.window ?? null]))
    : Object.entries((!Array.isArray(input) && input.quota && typeof input.quota === 'object' ? input.quota : input))
      .map(([k, v]) => [k, v, v?.window ?? null]);
  for (const [id, q, explicitWindow] of entries) {
    if (!q || typeof q !== 'object') continue;
    const resetsAt = parseResetMs(q, now);
    if (!resetsAt) continue;
    const used = typeof q.remaining_fraction === 'number' && Number.isFinite(q.remaining_fraction)
      ? pct((1 - q.remaining_fraction) * 100)
      : pct(q.used_percentage);
    if (used === null) continue;
    const tier = agyTier(id, explicitWindow);
    if (!tier) continue;
    (pools[tier.pool] ??= {})[span(tier.windowMs)] = { used, resetsAt, windowMs: tier.windowMs };
  }
  return pools;
}

const AGY_LOG_TAIL = 512 * 1024;

function readLogTailEmail(file) {
  let tail = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) return null;
      const buf = Buffer.alloc(Math.min(size, AGY_LOG_TAIL));
      tail = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, size - buf.length));
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  let email = null;
  for (const m of tail.matchAll(/applyAuthResult: email=([^\s,]+@[^\s,]+)/g)) email = m[1];
  return email;
}

/**
 * The authenticated Antigravity email: structured `email` from the latest statusLine snapshot
 * first (`~/.claude/bridge/agy-statusline-last.json`), falling back to `cli.log` / `log/cli-*.log`
 * before the first statusLine render.
 */
export function readAgyEmail(dir = AGY_DIR, { runtimeDir = BRIDGE_RUNTIME_DIR } = {}) {
  if (dir === AGY_DIR && runtimeDir) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(runtimeDir, AGY_STATUSLINE_LAST), 'utf8'));
      if (typeof snap?.email === 'string' && snap.email.includes('@')) return snap.email.trim();
    } catch { /* fall back to log */ }
  }
  const direct = readLogTailEmail(path.join(dir, 'cli.log'));
  if (direct) return direct;
  let logs = [];
  try {
    const logDir = path.join(dir, 'log');
    logs = fs.readdirSync(logDir).filter((n) => /^cli-.*\.log$/i.test(n))
      .map((n) => { const f = path.join(logDir, n); return { f, mtime: fs.statSync(f).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime).slice(0, 5);
  } catch { return null; }
  for (const { f } of logs) {
    const found = readLogTailEmail(f);
    if (found) return found;
  }
  return null;
}

const agyAccountHash = (email) => createHash('sha256').update((email ?? 'unknown').toLowerCase()).digest('hex').slice(0, 16);
/** One pool's series file, scoped by the login (as codex-usage-<home>-<account>.jsonl). */
export const agySeriesFile = (email, pool, dir = BRIDGE_RUNTIME_DIR) => path.join(dir, `agy-usage-${agyAccountHash(email)}-${pool}.jsonl`);

/** Record each pool's windows into its series (used by both `agy-statusline.mjs` and `refreshAgyQuota`). */
export function teeAgyUsage(payload, { email = null, dir = BRIDGE_RUNTIME_DIR, now = Date.now() } = {}) {
  const resolvedEmail = email ?? (typeof payload?.email === 'string' && payload.email.includes('@') ? payload.email.trim() : readAgyEmail(AGY_DIR, { runtimeDir: dir }));
  const pools = agyPools(payload, now);
  for (const [pool, windows] of Object.entries(pools)) recordSample(agySeriesFile(resolvedEmail, pool, dir), windows, now);
  return pools;
}

/**
 * Authoritative zero-token quota probe (`agy -p /quota --output-format json`): `num_turns: 0`,
 * `total_tokens: 0`, returns `command.data.groups[*].buckets[*]`. Refreshes the dashboard series
 * in the background so `gemini` and `claude-gpt` windows are populated even while no TUI renders.
 */
export function refreshAgyQuota({
  agyBin = resolveHostBinary('agy').path ?? 'agy',
  agyDir = AGY_DIR,
  dir = BRIDGE_RUNTIME_DIR,
  now = Date.now,
  exec = execFile,
} = {}) {
  if (!fs.existsSync(agyDir)) return Promise.resolve({});
  const email = readAgyEmail(agyDir, { runtimeDir: dir });
  if (!email) return Promise.resolve({});
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32' && /\.cmd$/i.test(agyBin)
      ? ['cmd.exe', ['/d', '/s', '/c', `${agyBin} -p /quota --output-format json`]]
      : [agyBin, ['-p', '/quota', '--output-format', 'json']];
    exec(cmd, args, { timeout: 20000, windowsHide: true, env: { ...process.env, CC_CONFIG_AGY_SMOKE: '1', CC_CONFIG_AGY_QUOTA_POLL: '1' } }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      try {
        const parsed = JSON.parse(String(stdout).trim());
        resolve(teeAgyUsage(parsed, { email, dir, now: now() }));
      } catch { resolve({}); }
    });
  });
}

/** This machine's agy pools as [{pool, account: {email}, quota}]: the current login's series, freshest pool first. */
export function readAgy({ email = readAgyEmail(), dir = BRIDGE_RUNTIME_DIR } = {}) {
  const prefix = `agy-usage-${agyAccountHash(email)}-`;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl')); } catch { return []; }
  return names.map((n) => ({ pool: n.slice(prefix.length, -'.jsonl'.length), account: email ? { email } : null, quota: quotaOf(readSeries(path.join(dir, n))) }))
    .filter((p) => AGY_POOL.test(p.pool) && p.quota).sort((a, b) => b.quota.at - a.quota.at || a.pool.localeCompare(b.pool));
}
