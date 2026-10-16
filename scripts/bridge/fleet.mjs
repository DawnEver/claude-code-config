// scripts/bridge/fleet.mjs — the fleet report: one Telegram message per machine per round,
// answering "which seat is this machine on, how much quota is left, when does it
// reset, will it run out first, and what is running here" (docs/bridge.md "Fleet report").
//
// Every input is an observation this machine already has; nothing is aggregated across
// machines and nothing calls a private endpoint:
//   - Claude quota and account, per local config dir (the base dir and each seat dir, see
//     scripts/shared/seats.mjs): the statusLine payload's `rate_limits`, teed by hud-hook.js
//     into the series <dir>/bridge/claude-usage.jsonl (only fresh while a session there
//     renders), and the dir's `.claude.json` `oauthAccount` (email + organization).
//   - Codex quota: the shared app-server's `account/rateLimits` (codex-adapter.mjs), recorded
//     every tick into the bridge runtime's codex-usage.jsonl series.
//   - Expected seats: top-level `seats`; report order: `bridge.fleet`; both in
//     claude_env_settings.json (sync payload, never in git), re-read every tick.
// A series (quota-series.mjs) holds each window's samples while it is current; its last
// sample is the quota now, the rest say where in the window it was spent (the trend row).
// One forecast per window (project): the current speed carried to the reset.
// A stale snapshot is shown as a floor (use only grows until a reset), never projected from;
// a passed reset is a new window at 0%. No data age is ever shown: only what is still true now.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readBridgeConfig } from './context.mjs';
import { fetchExtraResets } from './extra-resets.mjs';
import { burn, readSeries, recordSample } from './quota-series.mjs';
import { baseDir, holds, orgOk, readAccount, readSeats, sameText, seatDir, seatsFor, usageFile } from '../shared/seats.mjs';

const H = 3600000;
const CLAUDE_WINDOWS = { five_hour: 5 * H, seven_day: 168 * H };
// Too early in a window the average pace is noise; do not project or alert from it.
const MIN_ELAPSED_FRACTION = 0.1;
// A snapshot older than this is a floor on use (`≥`) and is never projected from.
const STALE_MS = 15 * 60000;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
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
 * window opened. No forecast from a stale snapshot, or too early in the window (`perHour`
 * null), or for an exhausted window (it says so itself). Feeds both the headline's run-out
 * warning and the trend row, so the two can never disagree.
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
 * with the series kept for the burn row. Null when there is nothing current to show.
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


const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** HH:MM today, else `07/Oct 23:00`: a date reads without counting weekdays. */
export function when(ms, now) {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (new Date(now).toDateString() === d.toDateString()) return hm;
  return `${pad(d.getDate())}/${MONTHS[d.getMonth()]} ${hm}`;
}

/** Time to `ms` in the two largest units: `4d 7h`, `3h 15m`, `12m`; a past time reads `19h ago`. */
export function countdown(ms, now) {
  const m = Math.round(Math.abs(ms - now) / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  const span = d ? `${d}d ${h}h` : h ? `${h}h ${min}m` : `${min}m`;
  return ms < now ? `${span} ago` : span;
}

export const TIME_FORMATS = ['date', 'countdown', 'both'];
/** bridge.fleet.timeFormat -> (ms, now) => text. both (default): `08/Oct 23:00 (4d 7h)`; date; countdown. */
export function timeFormatter(format) {
  if (format === 'date') return when;
  if (format === 'countdown') return countdown;
  return (ms, now) => `${when(ms, now)} (${countdown(ms, now)})`;
}

// Position: ten cells of `used`, with `┃` inserted at the cell boundary an even spend would
// have reached: fill past the marker is spending faster than the window lasts, fill short of
// it is headroom. Inserted, not overlaid, so the marker never hides a cell of fill.
const bar = (used, pace) => {
  const n = Math.round(used / 10);
  const cells = [...('█'.repeat(n) + '░'.repeat(10 - n))];
  if (pace != null) cells.splice(Math.round(pace / 10), 0, '┃');
  return cells.join('');
};

// Trend: the window on time, opening to reset. A past cell is the quota spent in that slice
// against an even spend in solid blocks (`▄` = on pace, `█` = twice it or more, blank =
// nothing, `░` never observed); a future cell is the current speed on the same scale in
// braille (`⣤` = on pace), so the forecast reads as a dotted continuation; `·` = no forecast.
const SOLID = '▁▂▃▄▅▆▇█';
const DOTTED = '⡀⣀⣄⣤⣦⣶⣷⣿';
const glyph = (set, level) => set[Math.min(set.length, Math.max(1, Math.ceil(level * 4))) - 1];
// About as wide as the position bar: 5h -> 10 cells of 30 min, 7d -> 14 of 12h.
const cellsFor = (windowMs) => Math.max(1, Math.round(windowMs / (windowMs <= 24 * H ? 30 * 60000 : 12 * H)));
const trend = (levels, ahead) => levels.map((l) => (l === null ? (ahead > 0 ? glyph(DOTTED, ahead) : '·')
  : l === undefined ? '░' : l <= 0 ? ' ' : glyph(SOLID, l))).join('');

/**
 * Every window of `q` with what the report says about it, computed once: the view `v`, the
 * even-spend use by now (`pace`), the trend cells, and the forecast `p` (see project).
 */
function windowModels(q, now) {
  return Object.entries(q?.windows ?? {}).map(([k, v]) => {
    const n = cellsFor(v.windowMs);
    if (v.resetsAt <= now) return { k, v, renewed: true, n };
    const fresh = !stale(q, now);
    const b = burn(q.series ?? [], k, { now, cells: n, seenUntil: fresh ? now : q.at });
    const p = project(v, { recent: b?.now ?? null, now, fresh });
    return { k, v, pace: paceAt(v, now), cells: b?.cells ?? Array(n).fill(null), p };
  });
}

// The report is Telegram rich Markdown (sendRichMessage): a `##` heading per host, a table of
// quota windows, bold warnings, code for things to act on. Every interpolated value is
// escaped, so an email, org or branch can never become markup.
const md = (v) => String(v).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');

// Codex plan ids and Claude seat tiers are wire ids; show the name each is sold under.
// Unlisted ids are title-cased (`edu_plus` -> `Edu Plus`).
const PLAN_NAMES = { self_serve_business_prolite: 'Business Premium', team_labs_premium: 'Team Premium', team_labs_standard: 'Team Standard' };
export const planName = (id) => PLAN_NAMES[id] ?? String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * What a reader looks for first: will the quota last until it resets? The binding window
 * is the one that runs out soonest, else the fullest. It heads the block as `NN% left`,
 * and a projected run-out sits right under the heading next to that window's reset.
 */
function headline(q, models, now, t) {
  const live = models.filter((m) => !m.renewed);
  if (!live.length) return { title: '', warn: [] };
  const short = live.filter((m) => m.p?.short).sort((a, b) => a.p.eta - b.p.eta);
  const { k, v, p } = short[0] ?? [...live].sort((a, b) => b.v.used - a.v.used)[0];
  const resets = `resets ${md(t(v.resetsAt, now))}`;
  // Exhausted stays true until the reset; a forecast exists only from a fresh snapshot.
  const warn = v.used >= 100 ? `${k} exhausted · ${resets}`
    : p?.short ? `${k} runs out ${md(t(p.eta, now))} · ${resets}` : null;
  return { title: ` · ${bound(q, v, now, '≤')}${Math.round(100 - v.used)}% left`, warn: warn ? [`**(\\!) ${warn}**`] : [] };
}

// Use only grows until a reset, so a stale snapshot's `used` is a floor, not an age to report:
// it reads `≥60%` (and `≤40% left`); 100% needs no mark, it stays true until the reset.
const stale = (q, now) => now - q.at > STALE_MS;
const bound = (q, v, now, mark) => (stale(q, now) && v.used < 100 ? mark : '');

/** The % of a window an even spend would have used by `now`: clock-only, so never stale. */
const paceAt = (v, now) => Math.min(100, Math.max(0, (1 - (v.resetsAt - now) / v.windowMs) * 100));

/**
 * The quota windows as one table, two rows each: position (where the use is against an even
 * spend) and trend (where it went since the reset, and where it is heading). `→` is the use at
 * the reset at the current speed; past 100% it is the run-out time instead, in bold. A passed
 * reset is a new window not yet started: zero use, nothing spent, no reset time yet.
 */
function quotaLines(q, models, now, t) {
  if (!q) return ['_no quota data yet_'];
  const rows = models.flatMap(({ k, v, renewed, n, pace, cells, p }) => {
    if (renewed) return [`| ${k} | \`${'░'.repeat(10)}\` 0% | — |`, `| | \`${'·'.repeat(n)}\` | |`];
    const ahead = p ? p.rate / (100 / (v.windowMs / H)) : null;
    // Times share the third column: the reset on the position row, a run-out on the trend row.
    const forecast = !p ? '→ —' : p.short ? `**→ ${Math.round(p.atReset)}%**` : `→ ${Math.round(p.atReset)}%`;
    return [`| ${k} | \`${bar(v.used, pace)}\` ${bound(q, v, now, '≥')}${Math.round(v.used)}% / ${Math.round(pace)}% | ${md(t(v.resetsAt, now))} |`,
      `| | \`${trend(cells, ahead)}\` ${forecast} |${p?.short ? ` **${md(t(p.eta, now))}** ` : ' '}|`];
  });
  return [['| | position · trend | resets · runs out |', '|---|---|---|', ...rows].join('\n')];
}

/** Codex reset credits still to spend, each with its expiry, soonest first. */
function resetCreditLines(rc, now, t) {
  if (!(rc?.availableCount > 0)) return [];
  const expiries = (Array.isArray(rc.credits) ? rc.credits : []).map((c) => (c?.expiresAt > 0 ? c.expiresAt * 1000 : Infinity))
    .filter((x) => x > now).sort((a, b) => a - b);
  return [`\`reset credits: ${rc.availableCount}\``, ...(expiries.length ? [expiries.map((x) => `- ${x === Infinity ? 'no expiry' : `expires ${md(t(x, now))}`}`).join('\n')] : [])];
}

/** An announced extra reset not applied yet; past ones are history, not news. */
function resetLines(s, now, t) {
  if (!s) return [];
  return [`**${s.url ? `[extra reset announced](${s.url})` : 'extra reset announced'}**${s.at ? ` · ${md(t(s.at, now))}` : ''}`];
}

const who = (email, org) => [email, org].filter(Boolean).join(' · ') || 'not logged in';
// An account is a name, not a link: code spans stop Telegram auto-linking the email.
const accountName = (email) => (email ? `\`${email.replace(/`/g, '')}\`` : '_not logged in_');

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
 * Render this machine's report (rich Markdown), or null when there is nothing to say. The
 * bot that posts it names the machine, so there is no machine title. A block appears only
 * when it is running something here, has a reset to act on (an announced
 * one, Codex reset credits), has a seat problem, or has quota data and
 * bridge.fleet.always is on for its host. Claude has one block per seat (`claude` = the
 * local config dirs, see readClaudeDirs), headed by the seat alias and the account it runs
 * as; seat checks sit there. Running means any registered session, whatever its state; a
 * Claude session counts in its config dir's seat (`seat` = alias, null for the base dir).
 */
export function renderReport({ machine, registry, codexAccount, claude = [], codex, codexResetCredits = null, extra = null, sessions = [], now }) {
  const t = timeFormatter(registry?.timeFormat);
  const running = (agent) => sessions.filter((x) => x.agent === agent);
  // One Markdown list of what runs here: project in bold, branch, state unless plain working.
  const runLines = (list) => (list.length ? [list.map((x) => `- **${md(x.project)}** · ${md(x.branch ?? 'detached')}${x.status === 'Working' ? '' : ` · _${md(x.status)}_`}`).join('\n')] : []);

  // bridge.fleet.always.{claude,codex}: a host with quota data reports every round, idle or
  // not. Default: Claude on, Codex off.
  const always = { claude: true, codex: false, ...registry?.always };
  const blocks = [];
  // Heading = verdict; then the warning; then who it runs as; then problems, the quota table,
  // and the rest. Headline and table read the same window models.
  const block = (host, q, email, detail, problems, rest) => {
    const models = windowModels(q, now);
    const h = headline(q, models, now, t);
    // Blank lines between parts: a single newline would fold them into one paragraph.
    blocks.push([`## ${host}${h.title}`, ...h.warn, `${accountName(email)}${detail ? ` · _${md(detail)}_` : ''}`,
      ...problems, ...quotaLines(q, models, now, t), ...rest].join('\n\n'));
  };

  const claudeRun = running('claude');
  for (const g of claudeGroups(claude, registry?.seats, machine)) {
    const run = claudeRun.filter((x) => g.aliases.includes(x.seat ?? null));
    if ((always.claude && g.quota) || run.length || extra?.Claude?.scheduled || g.problems.length) {
      block(g.label ? `Claude · ${md(g.label)}` : 'Claude', g.quota, g.account?.email,
        [g.account?.org, g.account?.tier && planName(g.account.tier)].filter(Boolean).join(' · '),
        g.problems.map((p) => `**(\\!) ${md(p)}**`), [...runLines(run), ...resetLines(extra?.Claude?.scheduled, now, t)]);
    }
  }
  const codexScheduled = extra?.Codex?.scheduled ?? null;
  const codexRun = running('codex');
  if ((always.codex && codex) || codexRun.length || codexScheduled || codexResetCredits?.availableCount > 0) {
    block('Codex', codex, codexAccount?.email, codexAccount?.plan && planName(codexAccount.plan), [],
      [...runLines(codexRun), ...resetCreditLines(codexResetCredits, now, t), ...resetLines(codexScheduled, now, t)]);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

/**
 * The report slot of `machine`: bridge.fleet `order` lists machines in reporting order; one
 * not listed reports last. Slots are a minute apart, so a round reads top to bottom.
 */
export function reportSlot(registry, machine) {
  const order = Array.isArray(registry?.order) ? registry.order : [];
  const i = order.indexOf(machine);
  return (i === -1 ? order.length : i) * 60000;
}

/**
 * The daemon side. Every `everyMinutes`, at this machine's slot in the fleet order, post a
 * fresh report and delete this machine's previous one, so the chat always holds the latest
 * round in order. Nothing is posted between rounds. State ({chatId, topicId, messageId,
 * round}) is a local transport cache; another chat/Topic starts it afresh.
 */
export class FleetReport {
  constructor({ telegram, chatId, topicId = null, everyMinutes = 60, machine, stateFile = null, sessions = () => [],
    codexQuota: codexSource = () => null, codexAccount = () => null, codexSeriesFile = null, log = () => {}, now = Date.now,
    extraResets = () => fetchExtraResets({ log }),
    read = { registry: () => ({ ...readBridgeConfig().fleet, seats: readSeats() }), claude: readClaudeDirs } }) {
    Object.assign(this, { telegram, chatId, topicId, machine, stateFile, sessions, codexSource, codexSeriesFile, codexAccount, extraResets, log, now, read });
    this.cycleMs = everyMinutes * 60000;
    const saved = stateFile && readJson(stateFile);
    this.state = saved?.chatId === chatId && (saved.topicId ?? null) === topicId
      ? saved : { chatId, topicId, messageId: null, round: null };
    this.running = null;
  }

  #save() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), { mode: 0o600 });
    } catch { /* cache only */ }
  }

  /** One tick at a time: an overlapping timer call joins the one in flight. */
  tick() {
    this.running ??= this.#tick().finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    const now = this.now();
    // Every tick feeds the Codex series, so a report shows where the quota went between rounds.
    const cx = this.codexSource();
    if (cx && this.codexSeriesFile) recordSample(this.codexSeriesFile, codexWindows(cx.limits), cx.at);
    const registry = this.read.registry();
    const round = Math.floor((now - reportSlot(registry, this.machine)) / this.cycleMs);
    if (round === this.state.round) return;
    const text = renderReport({ machine: this.machine, registry,
      codexAccount: this.codexAccount(), codexResetCredits: cx?.resetCredits ?? null,
      claude: this.read.claude(registry?.seats, this.machine), codex: cx ? quotaOf(this.codexSeriesFile ? readSeries(this.codexSeriesFile) : [{ from: cx.at, at: cx.at, windows: codexWindows(cx.limits) }]) : null,
      extra: await this.extraResets().catch(() => null), sessions: this.sessions(), now });
    const previous = this.state.messageId;
    // Nothing to say (idle, no reset to act on): the round still replaces the old report.
    const [sent] = text ? await this.telegram.sendMessage(this.chatId, text, { threadId: this.topicId ?? undefined, rich: true }) : [];
    this.state = { ...this.state, messageId: sent?.message_id ?? null, round };
    this.#save();
    if (previous) await this.telegram.deleteMessage(this.chatId, previous).catch(() => {});
  }
}
