// scripts/bridge/fleet.mjs — the fleet card: one Telegram message per machine, edited in
// place, answering "which seat is this machine on, how much quota is left, when does it
// reset, will it run out first, and what is running here" (docs/bridge.md "Fleet card").
//
// Every input is an observation this machine already has; nothing is aggregated across
// machines and nothing calls a private endpoint:
//   - Claude quota: the statusLine payload's `rate_limits`, teed by hud-hook.js into
//     ~/.claude/bridge/claude-usage.json (only fresh while a Claude session renders).
//   - Claude account: ~/.claude.json `oauthAccount` (email + organization).
//   - Codex quota: the shared app-server's `account/rateLimits` (codex-adapter.mjs).
//   - Expected seat: ~/.claude/fleet.json (sync payload, never in git: it names accounts).
// Rates are averaged since the window opened (resetsAt - window length) as of the
// snapshot, so no history is kept: a window's ETA is when that average pace reaches 100%.
// A stale snapshot is shown with its time but never alerts; a passed reset reads as such.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const CLAUDE_USAGE_FILE = path.join(os.homedir(), '.claude', 'bridge', 'claude-usage.json');
export const CLAUDE_ACCOUNT_FILE = path.join(os.homedir(), '.claude.json');
export const FLEET_REGISTRY_FILE = path.join(os.homedir(), '.claude', 'fleet.json');

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
 * fleet.json = {seats: [{name, email, org?, orgUuid?, machines: [<machine>], note?}]}
 */
export function seatFor(registry, machine) {
  const seats = Array.isArray(registry?.seats) ? registry.seats : [];
  const seat = seats.find((x) => x && typeof x === 'object' && Array.isArray(x.machines) && x.machines.includes(machine));
  return seat ? { name: String(seat.name ?? '?'), email: seat.email ?? null, org: seat.org ?? null,
    orgUuid: seat.orgUuid ?? null, note: seat.note ?? null } : null;
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

export function readRegistry(file = FLEET_REGISTRY_FILE) { return readJson(file); }
export function readClaudeUsage(file = CLAUDE_USAGE_FILE) { return readJson(file); }

const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
// A seat pins its org by `orgUuid` when given (exact), else by `org`: the name as a person
// writes it ("Acme Lab"), a case-insensitive substring of Claude's organizationName
// ("Uni Acme Lab"). Neither given: any org passes.
const orgOk = (account, seat) => (seat.orgUuid ? account.orgUuid === seat.orgUuid
  : !seat.org || String(account.org ?? '').toLowerCase().includes(String(seat.org).trim().toLowerCase()));

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** HH:MM today, `Ddd HH:MM` within a week, else `DD/MM HH:MM`. */
export function when(ms, now) {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (new Date(now).toDateString() === d.toDateString()) return hm;
  if (Math.abs(ms - now) < 6 * 24 * H) return `${DAYS[d.getDay()]} ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

const bar = (used) => { const n = Math.round(used / 10); return '█'.repeat(n) + '░'.repeat(10 - n); };
const ago = (ms) => (ms < H ? `${Math.round(ms / 60000)}m` : ms < 48 * H ? `${Math.round(ms / H)}h` : `${Math.round(ms / (24 * H))}d`);

/** `Claude 7d ███████░░░  69%  resets Wed 23:00`, + `(!) runs out ...` under it. */
function windowLines(host, k, v, now) {
  const label = `${host.padEnd(6)} ${k.padEnd(2)} `;
  if (v.resetsAt <= now) return [`${label}reset ${when(v.resetsAt, now)}, awaiting data`];
  const lines = [`${label}${bar(v.used)} ${`${Math.round(v.used)}%`.padStart(4)}  resets ${when(v.resetsAt, now)}`];
  if (v.short) lines.push(`${' '.repeat(label.length)}(!) runs out ${when(v.eta, now)}`);
  return lines;
}

function quotaLines(host, q, now) {
  if (!q) return [`${host.padEnd(6)} no data yet`];
  const lines = Object.entries(q.windows).flatMap(([k, v]) => windowLines(host, k, v, now));
  // Freshness only when it matters: an old snapshot says how old.
  if (now - q.at > STALE_MS) lines.push(`${' '.repeat(10)}data ${ago(now - q.at)} old`);
  return lines;
}

/**
 * Render this machine's card and the alerts that currently hold. An alert is keyed so
 * the caller can notify on transitions only. Account emails are never printed.
 * @returns {{text: string, alerts: {key: string, text: string}[]}}
 */
export function renderCard({ machine, registry, account, claude, codex, sessions = [], now }) {
  const alerts = [];
  const seat = seatFor(registry, machine);
  const lines = [`${machine} · ${seat?.name ?? (registry ? 'unregistered' : 'no fleet.json')}`];
  const flag = (key, line, alert = line) => { lines.push(`(!) ${line}`); alerts.push({ key, text: `${machine}: ${alert}` }); };
  if (registry && !seat) flag('unregistered', 'not in fleet.json');
  if (seat && !account) flag('seat:none', 'no Claude subscription login', `no Claude subscription login (expected ${seat.name})`);
  else if (seat && seat.email && !sameText(account.email, seat.email)) flag(`seat:${account.email}`, `Claude is logged into another account, expected ${seat.name}`);
  else if (seat && !orgOk(account, seat)) flag(`seat:${account.orgUuid ?? account.org}`, `Claude org is ${account.org ?? '?'}, expected ${seat.org ?? seat.orgUuid}`);
  if (seat?.note) lines.push(`note: ${seat.note}`);
  lines.push('', ...quotaLines('Claude', claude, now), ...quotaLines('Codex', codex, now), '');
  for (const [host, q] of [['Claude', claude], ['Codex', codex]]) {
    if (!q || now - q.at > STALE_MS) continue;
    for (const [k, v] of Object.entries(q.windows)) {
      if (v.short && v.resetsAt > now) alerts.push({ key: `short:${host}:${k}:${v.resetsAt}`, text: `${machine} ${host} ${k} at ${Math.round(v.used)}%: runs out ~${when(v.eta, now)}, resets ${when(v.resetsAt, now)}` });
    }
  }
  // What is running here: busy sessions by name; idle ones are not news.
  const busy = sessions.filter((x) => x.status !== 'Idle');
  lines.push(busy.length ? 'Running' : 'Running: nothing');
  for (const x of busy) lines.push(`  ${x.title}${x.status === 'Working' ? '' : ` · ${x.status}`}`);
  return { text: lines.join('\n'), alerts };
}

/**
 * The daemon side: render this machine's card into the configured fleet chat/Topic, edit
 * it in place when its text changes, and post an alert only when a new alert key appears.
 * State ({messageId, text, alerts}) is a local transport cache, like topics.json.
 */
export class FleetCard {
  constructor({ telegram, chatId, topicId = null, machine, stateFile = null, sessions = () => [],
    codexQuota: codexSource = () => null, alertIds = [], log = () => {}, now = Date.now,
    read = { registry: readRegistry, account: claudeAccount, claudeUsage: readClaudeUsage } }) {
    Object.assign(this, { telegram, chatId, topicId, machine, stateFile, sessions, codexSource, alertIds, log, now, read });
    this.state = (stateFile && readJson(stateFile)) ?? { messageId: null, text: null, alerts: [] };
  }

  #save() {
    if (!this.stateFile) return;
    try { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); } catch { /* cache only */ }
  }

  async tick() {
    const now = this.now();
    const cx = this.codexSource();
    const { text, alerts } = renderCard({ machine: this.machine, registry: this.read.registry(),
      account: this.read.account(), claude: claudeQuota(this.read.claudeUsage()),
      codex: cx ? codexQuota(cx.limits, cx.at) : null, sessions: this.sessions(), now });
    const opts = { threadId: this.topicId ?? undefined };
    if (text !== this.state.text) {
      let sent = false;
      if (this.state.messageId) {
        try { await this.telegram.editMessageText(this.chatId, this.state.messageId, text, { pre: true }); sent = true; }
        catch (e) {
          if (/not modified/i.test(e.message)) sent = true;
          else if (!/message to edit not found|MESSAGE_ID_INVALID/i.test(e.message)) throw e;
        }
      }
      if (!sent) this.state.messageId = (await this.telegram.sendMessage(this.chatId, text, { ...opts, pre: true }))[0]?.message_id ?? null;
      this.state.text = text;
    }
    const known = new Set(this.state.alerts);
    for (const a of alerts) if (!known.has(a.key)) await this.telegram.sendMessage(this.chatId, a.text, { ...opts, alert: this.alertIds });
    this.state.alerts = alerts.map((a) => a.key);
    this.#save();
  }
}
