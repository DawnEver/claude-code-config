// scripts/bridge/fleet.mjs — the fleet report: one Telegram message per machine per round,
// answering "which seat is this machine on, how much quota is left, when does it
// reset, will it run out first, and what is running here" (docs/bridge.md "Fleet report").
//
// Every input is an observation this machine already has; nothing is aggregated across
// machines and nothing calls a private endpoint:
//   - Claude quota and account, per local config dir (the base dir and each seat dir, see
//     scripts/shared/seats.mjs): the statusLine payload's `rate_limits`, teed by hud-hook.js
//     into <dir>/bridge/claude-usage.json (only fresh while a session there renders), and the
//     dir's `.claude.json` `oauthAccount` (email + organization).
//   - Codex quota: the shared app-server's `account/rateLimits` (codex-adapter.mjs).
//   - Expected seats: top-level `seats`; report order: `bridge.fleet`; both in
//     claude_env_settings.json (sync payload, never in git), re-read every tick.
// Rates are averaged since the window opened (resetsAt - window length) as of the
// snapshot, so no history is kept: a window's ETA is when that average pace reaches 100%.
// A stale snapshot says how old it is and is never projected from; a passed reset reads as such.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readBridgeConfig } from './context.mjs';
import { fetchExtraResets } from './extra-resets.mjs';
import { baseDir, holds, orgOk, readAccount, readSeats, sameText, seatDir, seatsFor, usageFile } from '../shared/seats.mjs';

const H = 3600000;
const CLAUDE_WINDOWS = { five_hour: 5 * H, seven_day: 168 * H };
// Too early in a window the average pace is noise; do not project or alert from it.
const MIN_ELAPSED_FRACTION = 0.1;
// A snapshot older than this still shows (with its time) but raises no alert.
const STALE_MS = 15 * 60000;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
/** A window's label from its length: 5h, 7d. */
const span = (ms) => (ms < 24 * H ? `${Math.round(ms / H)}h` : `${Math.round(ms / (24 * H))}d`);

/**
 * One quota window as observed at `at` (epoch ms, like `resetsAt`).
 * @returns {{used, resetsAt, windowMs, perHour, eta, short}|null} short = projected to run out before
 *   reset
 */
export function windowView({ used, resetsAt, windowMs, at }) {
  used = pct(used);
  if (used === null || !(resetsAt > at) || !(windowMs > 0)) return null;
  const elapsed = windowMs - (resetsAt - at);
  if (used >= 100) return { used, resetsAt, windowMs, perHour: null, eta: at, short: true };
  if (elapsed < windowMs * MIN_ELAPSED_FRACTION || used <= 0) return { used, resetsAt, windowMs, perHour: null, eta: null, short: false };
  const perMs = used / elapsed;
  const eta = at + (100 - used) / perMs;
  return { used, resetsAt, windowMs, perHour: perMs * H, eta, short: eta < resetsAt };
}

/** The hud-hook tee: {at, five_hour:{used_percentage, resets_at(sec)}, seven_day:{...}}. */
export function claudeQuota(snapshot) {
  if (!(snapshot?.at > 0)) return null;
  const windows = {};
  for (const [name, windowMs] of Object.entries(CLAUDE_WINDOWS)) {
    const w = snapshot[name];
    const v = w && windowView({ used: w.used_percentage, resetsAt: w.resets_at * 1000, windowMs, at: snapshot.at });
    if (v) windows[span(windowMs)] = v;
  }
  return Object.keys(windows).length ? { at: snapshot.at, windows } : null;
}

/** Codex `account/rateLimits` snapshot ({primary, secondary}) observed at `at` -> windows. */
export function codexQuota(limits, at) {
  if (!limits || !(at > 0)) return null;
  const windows = {};
  for (const w of [limits.primary, limits.secondary]) {
    if (!(w?.windowDurationMins > 0)) continue;
    const windowMs = w.windowDurationMins * 60000;
    const v = windowView({ used: w.usedPercent, resetsAt: w.resetsAt * 1000, windowMs, at });
    if (v) windows[span(windowMs)] = v;
  }
  return Object.keys(windows).length ? { at, windows } : null;
}

/**
 * hud-hook.js side: keep the latest statusLine `rate_limits` for the daemon. Rewritten only
 * when the values change or the copy is a minute old, so renders stay cheap. Fail-silent.
 */
export function teeClaudeUsage(statusLine, { file, now = Date.now() } = {}) {
  try {
    const rl = statusLine?.rate_limits;
    if (!rl?.five_hour && !rl?.seven_day) return false;
    const values = { five_hour: rl.five_hour ?? null, seven_day: rl.seven_day ?? null };
    const prev = readJson(file);
    if (prev && now - prev.at < 60000 && JSON.stringify({ five_hour: prev.five_hour, seven_day: prev.seven_day }) === JSON.stringify(values)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ at: now, ...values }));
      fs.renameSync(tmp, file);
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    return true;
  } catch { return false; }
}

/**
 * Every local Claude config dir as {alias, account, quota}: the base dir first (alias null),
 * then each of this machine's seats that has its dir.
 */
export function readClaudeDirs(seats, machine, home = os.homedir()) {
  const dirs = [{ alias: null, dir: baseDir(home) }, ...seatsFor(seats, machine).filter((x) => x.alias)
    .map((x) => ({ alias: x.alias, dir: seatDir(x.alias, home) })).filter((x) => fs.existsSync(x.dir))];
  return dirs.map(({ alias, dir }) => ({ alias, account: readAccount(dir, home), quota: claudeQuota(readJson(usageFile(dir))) }));
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

// Ten cells of `used`, with `┃` inserted at the cell boundary an even spend would have
// reached: fill past the marker is spending faster than the window lasts, fill short of it is
// headroom. Inserted, not overlaid, so the marker never hides a cell of fill.
const bar = (used, pace) => {
  const n = Math.round(used / 10);
  const cells = [...('█'.repeat(n) + '░'.repeat(10 - n))];
  if (pace != null) cells.splice(Math.round(pace / 10), 0, '┃');
  return cells.join('');
};
const ago = (ms) => (ms < H ? `${Math.round(ms / 60000)}m` : ms < 48 * H ? `${Math.round(ms / H)}h` : `${Math.round(ms / (24 * H))}d`);

// The report is Telegram rich Markdown (sendRichMessage): a `##` heading per host, a table of
// quota windows, bold warnings, code for things to act on. Every interpolated value is
// escaped, so an email, org or branch can never become markup.
const md = (v) => String(v).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');

// Codex reports wire plan ids; show the name the plan is sold under. Unlisted ids are
// title-cased (`edu_plus` -> `Edu Plus`).
const PLAN_NAMES = { self_serve_business_prolite: 'Business Premium' };
export const planName = (id) => PLAN_NAMES[id] ?? String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * What a reader looks for first: will the quota last until it resets? The binding window
 * is the one that runs out soonest, else the fullest. It heads the block as `NN% left`,
 * and a projected run-out sits right under the heading next to that window's reset.
 */
function headline(q, now, t) {
  const live = Object.entries(q?.windows ?? {}).filter(([, v]) => v.resetsAt > now);
  if (!live.length) return { title: '', warn: [] };
  const short = live.filter(([, v]) => v.short).sort((a, b) => a[1].eta - b[1].eta);
  const [k, v] = short[0] ?? live.sort((a, b) => b[1].used - a[1].used)[0];
  return { title: ` · ${Math.round(100 - v.used)}% left`,
    warn: v.short && now - q.at <= STALE_MS ? [`**(\\!) ${k} runs out ${md(t(v.eta, now))} · resets ${md(t(v.resetsAt, now))}**`] : [] };
}

/** The % of a window an even spend would have used by `now`: clock-only, so never stale. */
const paceAt = (v, now) => Math.min(100, Math.max(0, (1 - (v.resetsAt - now) / v.windowMs) * 100));

/** The quota windows as one table: the detail under the headline. */
function quotaLines(q, now, t) {
  if (!q) return ['_no quota data yet_'];
  const rows = Object.entries(q.windows).map(([k, v]) => {
    // A past reset has no countdown: always a date.
    if (v.resetsAt <= now) return `| ${k} | — | reset ${md(when(v.resetsAt, now))}, awaiting data |`;
    const pace = paceAt(v, now);
    return `| ${k} | \`${bar(v.used, pace)}\` ${Math.round(v.used)}% / ${Math.round(pace)}% | ${md(t(v.resetsAt, now))} |`;
  });
  const lines = [['| | used / pace | resets |', '|---|---|---|', ...rows].join('\n')];
  // Freshness only when it matters: an old snapshot says how old.
  if (now - q.at > STALE_MS) lines.push(`_data ${ago(now - q.at)} old_`);
  return lines;
}

/** Codex reset credits still to spend, each with its expiry, soonest first. */
function resetCreditLines(rc, now, t) {
  if (!(rc?.availableCount > 0)) return [];
  const expiries = (Array.isArray(rc.credits) ? rc.credits : []).map((c) => (c?.expiresAt > 0 ? c.expiresAt * 1000 : Infinity))
    .filter((x) => x > now).sort((a, b) => a - b);
  return [`\`reset credits: ${rc.availableCount}\``, ...(expiries.length ? [expiries.map((x) => `- ${x === Infinity ? 'no expiry' : `expires ${md(t(x, now))}`}`).join('\n')] : [])];
}

/** Banked resets still to claim and an announced one: what a person can act on. */
function actionableResets(x, claimed = []) {
  return { banked: (x?.banked ?? []).filter((e) => !claimed.includes(e.id)), scheduled: x?.scheduled ?? null };
}

/** Only resets a person can act on; past ones are history, not news. */
function resetLines(act, now, t) {
  const link = (e, text) => (e.url ? `[${text}](${e.url})` : text);
  return [
    ...act.banked.map((e) => `\`banked reset${e.name ? ` (${e.name})` : ''} · ${e.expires ? `use by ${t(e.expires, now)}` : 'no stated expiry'}\``),
    ...(act.scheduled ? [`**${link(act.scheduled, 'extra reset announced')}**${act.scheduled.at ? ` · ${md(t(act.scheduled.at, now))}` : ''}`] : []),
  ];
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
  for (const d of dirs) {
    const seat = d.alias ? mine.find((x) => x.alias === d.alias) ?? null
      : mine.find((x) => holds(d.account, x)) ?? (mine.length === 1 ? mine[0] : null);
    const problem = d.alias && !seat ? `seat ${d.alias} is not registered for ${machine}`
      : !d.alias && !mine.length && Array.isArray(seats) && seats.length ? `${machine} is not in seats`
      : seat ? seatProblem(d.account, seat) : null;
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
 * when it is running something here, has a reset to act on (a banked reset to claim, an
 * announced one, Codex reset credits), has a seat problem, or has quota data and
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
  // Heading = verdict; then the warning; then who it runs as; then the detail.
  const block = (host, q, email, detail, lines) => {
    const h = headline(q, now, t);
    // Blank lines between parts: a single newline would fold them into one paragraph.
    blocks.push([`## ${host}${h.title}`, ...h.warn, `${accountName(email)}${detail ? ` · _${md(detail)}_` : ''}`, ...lines].join('\n\n'));
  };

  const claudeRun = running('claude');
  for (const g of claudeGroups(claude, registry?.seats, machine)) {
    const act = actionableResets(extra?.Claude, g.seat?.claimed);
    const run = claudeRun.filter((x) => g.aliases.includes(x.seat ?? null));
    if ((always.claude && g.quota) || run.length || act.banked.length || act.scheduled || g.problems.length) {
      block(g.label ? `Claude · ${md(g.label)}` : 'Claude', g.quota, g.account?.email, g.account?.org,
        [...g.problems.map((p) => `**(\\!) ${md(p)}**`), ...quotaLines(g.quota, now, t), ...runLines(run), ...resetLines(act, now, t)]);
    }
  }
  const codexAct = actionableResets(extra?.Codex);
  const codexRun = running('codex');
  if ((always.codex && codex) || codexRun.length || codexAct.scheduled || codexResetCredits?.availableCount > 0) {
    block('Codex', codex, codexAccount?.email, codexAccount?.plan && planName(codexAccount.plan), [...quotaLines(codex, now, t),
      ...runLines(codexRun), ...resetCreditLines(codexResetCredits, now, t), ...resetLines(codexAct, now, t)]);
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
    codexQuota: codexSource = () => null, codexAccount = () => null, log = () => {}, now = Date.now,
    extraResets = (at) => fetchExtraResets({ now: at, log }),
    read = { registry: () => ({ ...readBridgeConfig().fleet, seats: readSeats() }), claude: readClaudeDirs } }) {
    Object.assign(this, { telegram, chatId, topicId, machine, stateFile, sessions, codexSource, codexAccount, extraResets, log, now, read });
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
    const registry = this.read.registry();
    const round = Math.floor((now - reportSlot(registry, this.machine)) / this.cycleMs);
    if (round === this.state.round) return;
    const cx = this.codexSource();
    const text = renderReport({ machine: this.machine, registry,
      codexAccount: this.codexAccount(), codexResetCredits: cx?.resetCredits ?? null,
      claude: this.read.claude(registry?.seats, this.machine), codex: cx ? codexQuota(cx.limits, cx.at) : null,
      extra: await this.extraResets(now).catch(() => null), sessions: this.sessions(), now });
    const previous = this.state.messageId;
    // Nothing to say (idle, no reset to act on): the round still replaces the old report.
    const [sent] = text ? await this.telegram.sendMessage(this.chatId, text, { threadId: this.topicId ?? undefined, rich: true }) : [];
    this.state = { ...this.state, messageId: sent?.message_id ?? null, round };
    this.#save();
    if (previous) await this.telegram.deleteMessage(this.chatId, previous).catch(() => {});
  }
}
