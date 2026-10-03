// scripts/bridge/fleet.mjs — the fleet report: one Telegram message per machine per round,
// answering "which seat is this machine on, how much quota is left, when does it
// reset, will it run out first, and what is running here" (docs/bridge.md "Fleet report").
//
// Every input is an observation this machine already has; nothing is aggregated across
// machines and nothing calls a private endpoint:
//   - Claude quota: the statusLine payload's `rate_limits`, teed by hud-hook.js into
//     ~/.claude/bridge/claude-usage.json (only fresh while a Claude session renders).
//   - Claude account: ~/.claude.json `oauthAccount` (email + organization).
//   - Codex quota: the shared app-server's `account/rateLimits` (codex-adapter.mjs).
//   - Expected seat and report order: `bridge.fleet` in claude_env_settings.json (sync
//     payload, never in git), re-read every tick.
// Rates are averaged since the window opened (resetsAt - window length) as of the
// snapshot, so no history is kept: a window's ETA is when that average pace reaches 100%.
// A stale snapshot is shown with its time but never alerts; a passed reset reads as such.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readBridgeConfig } from './context.mjs';
import { fetchExtraResets } from './extra-resets.mjs';

// CLAUDE_CONFIG_DIR moves both the config dir and its .claude.json, as hud-hook.js honours.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
export const CLAUDE_USAGE_FILE = path.join(CONFIG_DIR || path.join(os.homedir(), '.claude'), 'bridge', 'claude-usage.json');
export const CLAUDE_ACCOUNT_FILE = CONFIG_DIR ? path.join(CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');

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
 * @returns {{used, resetsAt, perHour, eta, short}|null} short = projected to run out before reset
 */
export function windowView({ used, resetsAt, windowMs, at }) {
  used = pct(used);
  if (used === null || !(resetsAt > at) || !(windowMs > 0)) return null;
  if (used >= 100) return { used, resetsAt, perHour: null, eta: at, short: true };
  const elapsed = windowMs - (resetsAt - at);
  if (elapsed < windowMs * MIN_ELAPSED_FRACTION || used <= 0) return { used, resetsAt, perHour: null, eta: null, short: false };
  const perMs = used / elapsed;
  const eta = at + (100 - used) / perMs;
  return { used, resetsAt, perHour: perMs * H, eta, short: eta < resetsAt };
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

/** ~/.claude.json oauthAccount -> {email, org, orgUuid}, or null when not on a subscription login. */
export function claudeAccount(file = CLAUDE_ACCOUNT_FILE) {
  const a = readJson(file)?.oauthAccount;
  return a?.emailAddress ? { email: a.emailAddress, org: a.organizationName ?? null, orgUuid: a.organizationUuid ?? null } : null;
}

/**
 * The registry entry for this machine, or null.
 * registry = bridge.fleet: {seats: [{email, org?, orgUuid?, machines: [<machine>]}]}.
 * A seat is a Claude seat (account x Team); Codex accounts are separate and not registered.
 */
export function seatFor(registry, machine) {
  const seats = Array.isArray(registry?.seats) ? registry.seats : [];
  const seat = seats.find((x) => x && typeof x === 'object' && Array.isArray(x.machines) && x.machines.includes(machine));
  return seat ? { email: seat.email ?? null, org: seat.org ?? null, orgUuid: seat.orgUuid ?? null } : null;
}

/**
 * hud-hook.js side: keep the latest statusLine `rate_limits` for the daemon. Rewritten only
 * when the values change or the copy is a minute old, so renders stay cheap. Fail-silent.
 */
export function teeClaudeUsage(statusLine, { file = CLAUDE_USAGE_FILE, now = Date.now() } = {}) {
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

export function readClaudeUsage(file = CLAUDE_USAGE_FILE) { return readJson(file); }

const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
// A seat pins its org by `orgUuid` when given (exact), else by `org`: the name as a person
// writes it ("Acme Lab"), a case-insensitive substring of Claude's organizationName
// ("Uni Acme Lab"). Neither given: any org passes.
const orgOk = (account, seat) => (seat.orgUuid ? account.orgUuid === seat.orgUuid
  : !seat.org || String(account.org ?? '').toLowerCase().includes(String(seat.org).trim().toLowerCase()));

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

const bar = (used) => { const n = Math.round(used / 10); return '█'.repeat(n) + '░'.repeat(10 - n); };
const ago = (ms) => (ms < H ? `${Math.round(ms / 60000)}m` : ms < 48 * H ? `${Math.round(ms / H)}h` : `${Math.round(ms / (24 * H))}d`);

// The report is Telegram HTML: bold heads, italic detail, and only the bar in monospace so
// it lines up while the rest reads in the normal font. Every interpolated value is escaped.
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `<code>7d ███████░░░  69%</code>  resets 08/Oct 23:00`, + a bold run-out warning. */
function windowLines(k, v, now, t) {
  // A past reset has no countdown: always a date.
  if (v.resetsAt <= now) return [`<code>${esc(k.padEnd(3))}</code> reset ${esc(when(v.resetsAt, now))}, awaiting data`];
  const lines = [`<code>${esc(k.padEnd(3))}${bar(v.used)} ${`${Math.round(v.used)}%`.padStart(4)}</code>  resets ${esc(t(v.resetsAt, now))}`];
  if (v.short) lines.push(`<b>(!) runs out ${esc(t(v.eta, now))}</b>`);
  return lines;
}

function quotaLines(q, now, t) {
  if (!q) return ['<i>no quota data yet</i>'];
  const lines = Object.entries(q.windows).flatMap(([k, v]) => windowLines(k, v, now, t));
  // Freshness only when it matters: an old snapshot says how old.
  if (now - q.at > STALE_MS) lines.push(`<i>data ${ago(now - q.at)} old</i>`);
  return lines;
}

/**
 * Codex `rateLimitResetCredits` ({availableCount, credits: [{expiresAt(sec)|null}]}) ->
 * `reset credits: 2` and one `expires ...` line per credit, soonest first (`no expiry`
 * when the backend gives none). Claude exposes no such count.
 */
function resetCreditLines(rc, now, t) {
  if (!(rc?.availableCount >= 0)) return [];
  const credits = (Array.isArray(rc.credits) ? rc.credits : []).map((c) => (c?.expiresAt > 0 ? c.expiresAt * 1000 : Infinity))
    .filter((ms) => ms > now).sort((a, b) => a - b);
  return [`<code>reset credits: ${rc.availableCount}</code>`,
    ...credits.map((ms) => `  ${ms === Infinity ? 'no expiry' : `expires ${esc(t(ms, now))}`}`)];
}

// Codex reports wire plan ids; show the name the plan is sold under. Unlisted ids are
// title-cased (`edu_plus` -> `Edu Plus`).
const PLAN_NAMES = { self_serve_business_prolite: 'Business Premium' };
export const planName = (id) => PLAN_NAMES[id] ?? String(id).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * One host's extra-reset state (extra-resets.mjs): a banked reset still to claim (with its
 * use-by), an announced one not applied yet, and the latest applied one, linked to its source.
 */
function extraResetLines(x, now, t) {
  if (!x) return [];
  const link = (e, text) => (e.url ? `<a href="${esc(e.url)}">${text}</a>` : text);
  return [
    ...x.banked.map((e) => `<code>banked reset · ${esc(e.expires ? `use by ${t(e.expires, now)}` : 'no stated expiry')}</code>`),
    ...(x.scheduled ? [`<b>${link(x.scheduled, 'extra reset announced')}</b>${x.scheduled.at ? ` · ${esc(t(x.scheduled.at, now))}` : ''}`] : []),
    ...(x.applied ? [`<i>${link(x.applied, 'last extra reset')} ${esc(t(x.applied.at, now))}${x.applied.scope ? ` · ${esc(x.applied.scope)}` : ''}</i>`] : []),
  ];
}

const who = (email, org) => [email, org].filter(Boolean).join(' · ') || 'not logged in';

/**
 * Render this machine's report (Telegram HTML) and the alerts that currently hold (plain
 * text). One block per host, each headed by the account it actually runs as (full email,
 * organization in italics): a seat (bridge.fleet.seats) is a Claude seat, so its note and
 * checks sit in the Claude block; Codex runs on its own account. Alert keys name the
 * condition, never an account.
 * @returns {{text: string, alerts: {key: string, text: string, until: number|null}[]}}
 */
export function renderReport({ machine, registry, account, codexAccount, claude, codex, codexResetCredits = null, extra = null, sessions = [], now }) {
  const alerts = [];
  const t = timeFormatter(registry?.timeFormat);
  const seat = seatFor(registry, machine);
  const head = (host, email, detail) => [`<b>${host}</b> · ${esc(email ?? 'not logged in')}`, ...(detail ? [`<i>${esc(detail)}</i>`] : [])];
  const claudeLines = [...head('Claude', account?.email, account?.org), ...quotaLines(claude, now, t)];
  claudeLines.push(...extraResetLines(extra?.Claude, now, t));
  const flag = (key, text) => { claudeLines.push(`<b>(!) ${esc(text)}</b>`); alerts.push({ key, text: `${machine} Claude: ${text}`, until: null }); };
  const expected = seat && who(seat.email, seat.org ?? seat.orgUuid);
  if (registry?.seats?.length && !seat) flag('unregistered', `${machine} is not in bridge.fleet.seats`);
  else if (seat && !account) flag('seat:none', `no subscription login, expected ${expected}`);
  else if (seat && seat.email && !sameText(account.email, seat.email)) flag('seat:account', `wrong account, expected ${expected}`);
  else if (seat && !orgOk(account, seat)) flag('seat:org', `wrong team, expected ${expected}`);
  const codexLines = codexAccount ? head('Codex', codexAccount.email, codexAccount.plan && planName(codexAccount.plan)) : ['<b>Codex</b> · <i>account unknown</i>'];
  const lines = [`<b>${esc(machine)}</b>`, '', ...claudeLines, '', ...codexLines, ...quotaLines(codex, now, t), ...resetCreditLines(codexResetCredits, now, t), ...extraResetLines(extra?.Codex, now, t), ''];
  for (const [host, q] of [['Claude', claude], ['Codex', codex]]) {
    if (!q || now - q.at > STALE_MS) continue;
    for (const [k, v] of Object.entries(q.windows)) {
      // Keyed by the hour of reset (servers jitter it by seconds); held until that reset.
      if (v.short && v.resetsAt > now) alerts.push({ key: `short:${host}:${k}:${Math.round(v.resetsAt / H)}`, until: v.resetsAt, text: `${machine} ${host} ${k} at ${Math.round(v.used)}%: runs out ${t(v.eta, now)}, resets ${t(v.resetsAt, now)}` });
    }
  }
  // What is running here: busy sessions by name; idle ones are not news.
  const busy = sessions.filter((x) => x.status !== 'Idle' && x.status !== 'Ended');
  lines.push(busy.length ? '<b>Running</b>' : '<b>Running</b> · <i>nothing</i>');
  // Unknown = connected but not yet observed (e.g. just after a bridge restart): shown as `?`.
  for (const x of busy) lines.push(`• ${esc(x.title)}${x.status === 'Working' ? '' : x.status === 'Unknown' ? ' · ?' : ` · ${esc(x.status)}`}`);
  return { text: lines.join('\n'), alerts };
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
 * round in order. Between rounds only a new alert is posted (silently, once): a run-out
 * alert stays "sent" until its window resets, a seat alert until its condition clears.
 * State ({chatId, topicId, messageId, round, sent}) is a local transport cache; another
 * chat/Topic starts it afresh.
 */
export class FleetReport {
  constructor({ telegram, chatId, topicId = null, everyMinutes = 60, machine, stateFile = null, sessions = () => [],
    codexQuota: codexSource = () => null, codexAccount = () => null, log = () => {}, now = Date.now,
    extraResets = (at) => fetchExtraResets({ now: at, log }),
    read = { registry: () => readBridgeConfig().fleet, account: claudeAccount, claudeUsage: readClaudeUsage } }) {
    Object.assign(this, { telegram, chatId, topicId, machine, stateFile, sessions, codexSource, codexAccount, extraResets, log, now, read });
    this.cycleMs = everyMinutes * 60000;
    const saved = stateFile && readJson(stateFile);
    this.state = saved?.chatId === chatId && (saved.topicId ?? null) === topicId && saved.sent
      ? saved : { chatId, topicId, messageId: null, round: null, sent: {} };
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
    const cx = this.codexSource();
    const round = Math.floor((now - reportSlot(registry, this.machine)) / this.cycleMs);
    const due = round !== this.state.round;
    // Extra resets are fetched only for a report: once per round, never per alert tick.
    const extra = due ? await this.extraResets(now).catch(() => null) : null;
    const { text, alerts } = renderReport({ machine: this.machine, registry,
      account: this.read.account(), codexAccount: this.codexAccount(), codexResetCredits: cx?.resetCredits ?? null, claude: claudeQuota(this.read.claudeUsage()),
      codex: cx ? codexQuota(cx.limits, cx.at) : null, extra, sessions: this.sessions(), now });
    const before = JSON.stringify(this.state);
    const opts = { threadId: this.topicId ?? undefined };
    try {
      if (due) {
        const previous = this.state.messageId;
        this.state.messageId = (await this.telegram.sendMessage(this.chatId, text, { ...opts, html: true }))[0]?.message_id ?? null;
        this.state.round = round;
        if (previous) await this.telegram.deleteMessage(this.chatId, previous).catch(() => {});
      }
      const holding = new Set(alerts.map((a) => a.key));
      for (const [key, until] of Object.entries(this.state.sent)) {
        if (until == null ? !holding.has(key) : until <= now) delete this.state.sent[key];
      }
      for (const a of alerts) {
        if (a.key in this.state.sent) continue;
        await this.telegram.sendMessage(this.chatId, a.text, opts);
        this.state.sent[a.key] = a.until;   // recorded per alert: a later failure cannot resend it
      }
    } finally {
      if (JSON.stringify(this.state) !== before) this.#save();
    }
  }
}
