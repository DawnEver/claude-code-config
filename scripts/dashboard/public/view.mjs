// scripts/dashboard/public/view.mjs — pure view logic of the Mini App (no DOM), shared by
// app.js and the tests. Status comes from the gateway as reported by the host; the only thing
// the view adds is freshness: a session of an offline host reads `Stale`, never its last state.
// The page answers, in order: does anything need me, what is running, where.

import { STATUS, QUOTA_STALE_MS, agentName } from './shared/vocab.mjs';
import { quotaView, alertKey } from './shared/quota-model.mjs';

export { QUOTA_STALE_MS, agentName, quotaView, alertKey };
/** A session's status as shown: the host's status, or `stale` when its host went silent. */
export const STATUS_LABELS = { ...Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])), stale: 'Stale' };
export const ATTENTION = ['needs_approval', 'needs_input'];
/** Most urgent first: what needs the human, then what runs, then the rest. */
const RANK = { ...Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.rank])), stale: Object.keys(STATUS).length };

/** The status chips: each a predicate over a session's display status. */
export const GROUPS = {
  all: { label: 'All', has: () => true },
  attention: { label: 'Needs you', has: (st) => ATTENTION.includes(st) },
  working: { label: 'Working', has: (st) => st === 'working' },
  idle: { label: 'Idle', has: (st) => st === 'idle' },
  stale: { label: 'Offline', has: (st) => st === 'stale' },
};

export const displayStatus = (s) => (s.stale ? 'stale' : s.status);

export function sessionsOf(snapshot) {
  return snapshot.hosts.flatMap((h) => h.sessions);
}

/** The sessions running on one account (one budget: on any host), most urgent first, each with its host. */
export const accountSessions = (snapshot, key) =>
  sortSessions(snapshot.hosts.flatMap((h) => h.sessions.filter((s) => s.account === key).map((s) => ({ ...s, host: h.id }))));

export const sortSessions =(sessions) => [...sessions].sort((a, b) =>
  (RANK[displayStatus(a)] ?? 9) - (RANK[displayStatus(b)] ?? 9) || String(a.project).localeCompare(String(b.project)));

/** Distinct host and project values, and how many sessions each status chip holds. */
export function filterOptions(snapshot) {
  const all = sessionsOf(snapshot);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const counts = Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, all.filter((s) => g.has(displayStatus(s))).length]));
  return { host: snapshot.hosts.map((h) => h.id), agent: uniq(all.map((s) => s.agent)), project: uniq(all.map((s) => s.project)), counts };
}

/** The one host order of every tab: online first, then by name. */
export const sortHosts = (hosts) => [...hosts].sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));

/**
 * `hosts` (hostsView) with their sessions narrowed by `filters` ({host, agent, project: '' = all;
 * group: a GROUPS key}) and sorted by urgency, host order kept. A narrowing filter drops empty hosts.
 */
export function applyFilters(hosts, filters) {
  const group = GROUPS[filters.group] ?? GROUPS.all;
  const narrowed = filters.agent || filters.project || (filters.group && filters.group !== 'all');
  return hosts.filter((h) => !filters.host || h.id === filters.host).map((h) => ({ ...h,
    sessions: sortSessions(h.sessions.filter((s) => (!filters.agent || s.agent === filters.agent)
      && (!filters.project || s.project === filters.project) && group.has(displayStatus(s)))) }))
    .filter((h) => !narrowed || h.sessions.length);
}

/** Live sessions waiting for the human, across hosts, most urgent first. */
export const attention = (snapshot) => sortSessions(sessionsOf(snapshot).filter((s) => !s.stale && ATTENTION.includes(s.status)));

/**
 * How long a session has been in its current state, from its last activity (the snapshot has no
 * per-state timestamp; status changes are activity, so it is the time since the last change).
 */
export function stateAge(s, now = Date.now()) {
  const at = Date.parse(s.lastActivityAt);
  const word = s.stale ? null : ATTENTION.includes(s.status) ? 'waiting' : s.status === 'idle' || s.status === 'working' ? s.status : null;
  if (!word || !Number.isFinite(at)) return ago(s.lastActivityAt, now);
  return `${word} ${span(now - at)}`;
}

/** A duration in its largest whole unit: <1m, 12m, 3h, 2d. */
function span(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

/**
 * When the session last posted to its Topic, or null when it never did: `style` 'ago' (reply 5m ago)
 * or 'clock', the 24h time (reply 14:05; a weekday or date before it when not today).
 */
export function replyTime(s, now = Date.now(), style = 'ago') {
  const at = Date.parse(s.lastPostAt);
  if (!Number.isFinite(at)) return null;
  if (style !== 'clock') return `reply ${span(now - at)} ago`;
  const hm = formatTime(at, { clock: '24', date: 'off' }), day = chatTime(s.lastPostAt, now, { clock: '24' });
  return `reply ${day === hm ? hm : `${day} ${hm}`}`;
}

/**
 * What is unread on this device: the host counts posts since the human spoke in the Topic, and
 * `seen` is the session's `posted` count when this page last opened the Topic, so posts that were
 * already there then are read here even if nobody wrote back.
 */
export function unreadHere(s, seen) {
  const unread = s.unread ?? 0, posted = s.posted ?? 0;
  return Number.isSafeInteger(seen) && seen <= posted ? Math.min(unread, posted - seen) : unread;
}

/**
 * Where tapping a session opens its Topic: at the latest post (`to` 'latest'), or at the first
 * unread one ('first') while everything the host counts is still unread here (once this page
 * opened the Topic, the first post still unread is not known, so the latest stands in).
 */
export function topicTarget(s, seen, to = 'latest') {
  const t = s.topic;
  if (!t) return null;
  const n = unreadHere(s, seen);
  if (to === 'first' && n && n === s.unread && t.firstUnreadUrl) return t.firstUnreadUrl;
  return t.latestUrl ?? t.url;
}

/**
 * The sessions view grouped `by` 'host' (the filtered hosts as they are) or 'project': one group
 * per project across hosts, by name, sessions by urgency; `online` when any of its hosts is.
 */
export function groupSessions(hosts, by = 'host', order = 'host') {
  if (by !== 'project') return hosts;
  const rank = new Map(hosts.map((h, i) => [h.id, i]));
  // Inside a project: by workstation (in the host order given), most urgent first within one; or by urgency alone.
  const arrange = (list) => (order === 'host' ? sortSessions(list).sort((a, b) => rank.get(a.hostId) - rank.get(b.hostId)) : sortSessions(list));
  const groups = new Map();
  for (const h of hosts) for (const s of h.sessions) {
    const id = s.project ?? 'unknown project';
    const g = groups.get(id) ?? { id, online: false, sessions: [] };
    g.online ||= h.online;
    g.sessions.push({ ...s, hostId: s.hostId ?? h.id });
    groups.set(id, g);
  }
  return [...groups.values()].map((g) => ({ ...g, sessions: arrange(g.sessions) })).sort((a, b) => a.id.localeCompare(b.id));
}

/** What a session is called: its own name (renamed or generated), else its project. */
export const sessionLabel = (s) => s.name ?? s.project ?? 'unknown project';

/** A chat list's time column: the clock today, the weekday within a week, else the date. */
export function chatTime(iso, now = Date.now(), { clock = '24' } = {}) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const d = new Date(at), today = new Date(now);
  if (d.toDateString() === today.toDateString()) return formatTime(at, { clock, date: 'off' });
  return now - at < 6 * 86400000 ? WEEKDAYS[d.getDay()] : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** A count badge as Telegram draws it: up to 99, then 99+. */
export const unreadBadge = (n) => (n > 99 ? '99+' : n > 0 ? String(n) : '');

const GB = 1024 ** 3;
const gb = (b) => (b / GB >= 10 ? Math.round(b / GB) : Math.round((b / GB) * 10) / 10);

/**
 * A host's load: `meters` (CPU, memory, then each GPU's compute and memory), each a short value
 * that always fits beside its bar, and `about`, what the hardware is (CPU model, cores, memory size and type, GPU models) — a
 * line of its own, so a long model name never crowds a number. Empty when nothing was reported.
 */
export function resourceView(r) {
  if (!r) return { meters: [], about: '' };
  const pct = (used, total) => Math.round((used / total) * 100);
  const meters = [];
  if (r.cpu !== null && r.cpu !== undefined) meters.push({ label: 'CPU', pct: r.cpu, text: `${r.cpu}%` });
  if (r.mem) meters.push({ label: 'RAM', pct: pct(r.mem.used, r.mem.total), text: `${gb(r.mem.used)}/${gb(r.mem.total)} GB` });
  const gpus = r.gpus ?? [];
  gpus.forEach((g, i) => {
    const label = gpus.length > 1 ? `GPU${i}` : 'GPU';
    meters.push({ label, pct: g.util ?? 0, text: `${g.util ?? '?'}%` });
    meters.push({ label: `${label} MEM`, pct: pct(g.memUsed, g.memTotal), text: `${gb(g.memUsed)}/${gb(g.memTotal)} GB` });
  });
  const about = [r.cpuModel, r.cores && `${r.cores} cores`, r.mem && `${gb(r.mem.total)} GB${r.mem.type ? ` ${r.mem.type}` : ''}`,
    ...gpus.map((g, i) => g.name && (gpus.length > 1 ? `GPU${i} ${g.name}` : g.name))].filter(Boolean).join(' · ');
  return { meters, about };
}

export function stats(snapshot) {
  const live = sessionsOf(snapshot).filter((s) => !s.stale);
  return { hostsOnline: snapshot.hosts.filter((h) => h.online).length, hosts: snapshot.hosts.length,
    working: live.filter((s) => s.status === 'working').length,
    attention: live.filter((s) => ATTENTION.includes(s.status)).length };
}

/**
 * An absolute time as this device chose to read it: `clock` '24' (default) or '12'; `date` 'day'
 * (21 Oct, default), 'iso' (2026-10-21) or 'off'. Local time zone.
 */
export function formatTime(ms, { clock = '24', date = 'day' } = {}) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const h = d.getHours();
  const time = clock === '12' ? `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:${pad(d.getMinutes())}`;
  const day = date === 'iso' ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : date === 'day' ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : '';
  return day ? `${day} ${time}` : time;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ago(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Quota (per account; computed by the host, scripts/bridge/quota.mjs accountModels) ──


/** Time to `ms` in its two largest units: `4d 7h`, `3h 15m`, `12m`. */
export function countdown(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((ms - now) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${min}m` : `${min}m`;
}

export const accountName = (q) => `${agentName(q.agent)}${q.label ? ` · ${q.label}` : ''}`;

/** Why an account needs the human, in one line; '' when it does not. `withReset: false` where the row already shows it. */
export function verdictText(q, { now = Date.now(), withReset = true } = {}) {
  const reset = withReset && q.bind?.resetsAt > now ? ` · resets in ${countdown(q.bind.resetsAt, now)}` : '';
  if (q.verdict === 'exhausted') return `${q.bind.k} exhausted${reset}`;
  if (q.verdict === 'short') return `${q.bind.k} runs out in ${countdown(q.bind.forecast.eta, now)}${reset}`;
  return '';
}

/** A window's reset countdown; '' once the reset is past or unknown (a new window has none to show). */
export const resetText = (w, now = Date.now()) => (!w.renewed && w.resetsAt > now ? `↻ ${countdown(w.resetsAt, now)}` : '');

/** A window's label in the page's one unit, % left; a stale reading is a ceiling (`≤`) unless already exhausted. */
export function windowLabel(w, stale, unit = 'left') {
  // A passed reset is all that is known: the last reading predates it, so the use now is unknown, not zero.
  if (w.renewed) return { text: 'not read', title: 'the window has reset since the last reading; use unknown until the account is used on this host', stale: false };
  const left = Math.max(0, Math.round(100 - w.used));
  const ceiling = stale && left > 0;
  const n = amount(w.used, unit);
  const bound = ceiling ? (unit === 'left' ? '≤' : '≥') : '';
  return { text: `${bound}${n}%`, title: `${ceiling ? (unit === 'left' ? 'at most' : 'at least') : ''}${ceiling ? ' ' : ''}${n}% ${unit}${ceiling ? ' (stale reading)' : ''}`, stale: ceiling };
}

/** A window's use as the reader chose to see it: what is left (default) or what is used. The one place the unit is applied. */
export const amount = (used, unit = 'left') => Math.round(unit === 'left' ? Math.max(0, 100 - used) : Math.min(100, used));

/** An email's local part, for a meta line with the full address in its title. */
export const emailName = (email) => email?.split('@')[0] ?? null;

/** Per agent, the account with most left on its binding window right now; exhausted and unread ones never win. */
export function bestAccounts(accounts) {
  const best = new Map();
  for (const q of accounts) {
    if (q.left === null || q.verdict === 'exhausted' || q.verdict === 'none') continue;
    if (!best.has(q.agent) || q.left > best.get(q.agent).left) best.set(q.agent, q);
  }
  return [...best].map(([agent, q]) => ({ agent, q }));
}

/**
 * Accounts that need the human: a window exhausted (a forecast run-out is shown on the account
 * row, never alerted); minus the alerts already read (`read`: alert keys). `index` is the
 * render's accountIndex, so a page computes each account's view once.
 */
export const quotaAlerts = (snapshot, now = Date.now(), read = [], index = accountIndex(snapshot, now)) =>
  [...index.values()]
    .filter((q) => q.verdict === 'exhausted' && !read.includes(alertKey(q)));


/**
 * Time ticks for a window's trend, whose axis runs from the window's opening to its reset, in
 * the reader's local time: a short window (≤ 1 day) ticks at every full hour labelled by the
 * hour of the day, a long one at every local midnight labelled by weekday and date. `pos` is
 * 0..1 along the axis; `now` is where the present sits on it (null once past the reset).
 */
export function timeTicks(w, now = Date.now()) {
  if (!w.resetsAt || !w.windowMs) return { ticks: [], now: null };
  const start = w.resetsAt - w.windowMs;
  const daily = w.windowMs > 86400000;
  const first = new Date(start);
  if (daily) first.setHours(24, 0, 0, 0); else first.setMinutes(60, 0, 0);
  const ticks = [];
  for (const t = first; t.getTime() < w.resetsAt; daily ? t.setDate(t.getDate() + 1) : t.setHours(t.getHours() + 1)) {
    ticks.push({ at: t.getTime(), pos: (t.getTime() - start) / w.windowMs,
      label: daily ? `${WEEKDAYS[t.getDay()]} ${t.getDate()}` : String(t.getHours()).padStart(2, '0') });
  }
  return { ticks, now: now >= start && now <= w.resetsAt ? (now - start) / w.windowMs : null };
}

/**
 * The config tab: one row per editable key any host reports. The shared value is the freshest
 * online host's; a host reading another value is still syncing (`differs`), or overrides it
 * locally (`overrides`: a shared edit will not reach it). `meta` is the key's CONFIG_KEYS entry
 * (label, bounds or options), matching a project key to its `*` pattern.
 */
export function configView(snapshot) {
  const metas = snapshot.configKeys ?? [];
  // A `*` segment matches any one segment of the dotted key.
  const fits = (pattern, key) => { const p = pattern.split('.'), k = key.split('.'); return p.length === k.length && p.every((x, i) => x === '*' || x === k[i]); };
  const metaOf = (key) => metas.find((m) => m.key === key) ?? metas.find((m) => fits(m.key, key)) ?? null;
  // The shared value is read from the freshest online host; the hosts are listed in the one host order.
  const hosts = [...snapshot.hosts].filter((h) => h.config).sort((a, b) => Number(b.online) - Number(a.online)
    || String(b.lastSeen).localeCompare(String(a.lastSeen)));
  const keys = [...new Set(hosts.flatMap((h) => Object.keys(h.config.editable)))].sort();
  return {
    rows: keys.map((key) => {
      const reporting = hosts.filter((h) => key in h.config.editable);
      const value = reporting[0].config.editable[key];
      return { key, meta: metaOf(key), value,
        differs: reporting.filter((h) => h.config.editable[key] !== value && !h.config.localOverrides.includes(key)).map((h) => ({ host: h.id, value: h.config.editable[key] })),
        overrides: reporting.filter((h) => h.config.localOverrides.includes(key)).map((h) => h.id),
        pending: (snapshot.configPending ?? []).find((c) => c.key === key) ?? null };
    }).filter((r) => r.meta),
    hosts: sortHosts(hosts),
  };
}

/** Every account as the reader sees it, by key: what a session (its `account`) or a host refers to. */
export const accountIndex = (snapshot, now = Date.now()) => new Map((snapshot.accounts ?? []).map((a) => [a.key, quotaView(a, now)]));

/** An account in a few characters: the seat alias, else the email's name, else the agent. */
export const accountTag = (q) => q.label ?? q.email?.split('@')[0] ?? agentName(q.agent);

/**
 * The one host model every tab renders from: each host as the gateway reported it (online,
 * lastSeen, resources, sessions) plus the accounts it runs, in the one host order. An account is
 * one budget however many hosts spend it, so a shared one says where else it runs (`sharedWith`)
 * rather than reading as a second budget: its full card sits on the first host in order,
 * elsewhere `refTo` names that host. Every host is listed, with or without accounts.
 */
export function hostsView(snapshot, now = Date.now(), index = accountIndex(snapshot, now)) {
  const accounts = [...index.values()];
  const hosts = sortHosts(snapshot.hosts);
  const owner = new Map();
  for (const h of hosts) for (const q of accounts) if (q.hosts?.includes(h.id) && !owner.has(q.key)) owner.set(q.key, h.id);
  return hosts.map((h) => ({ ...h, accounts: accounts.filter((q) => q.hosts?.includes(h.id))
    .map((q) => ({ ...q, sharedWith: q.hosts.filter((x) => x !== h.id), refTo: owner.get(q.key) === h.id ? null : owner.get(q.key) })) }));
}

/**
 * The tabs below the needs-you card, each answering one question: what runs (sessions), will
 * the quota last (quota), what happened (events: the alerts, as history). `alert` marks the
 * quota tab while an unread quota alert stands; `unseen` counts events newer than `seenAt`;
 * `events` counts what the Events tab lists (unread when it was opened, `shownFrom`).
 */
export function tabs(snapshot, now = Date.now(), seenAt = null, read = [], shownFrom = seenAt, index = accountIndex(snapshot, now)) {
  const accounts = snapshot.accounts ?? [];
  const events = snapshot.events ?? [];
  return { sessions: sessionsOf(snapshot).length, quota: accounts.length, alert: quotaAlerts(snapshot, now, read, index).length > 0,
    events: unreadEvents(events, shownFrom).length, unseen: events.filter((e) => !seenAt || e.at > seenAt).length };
}

/**
 * An event (registry.mjs: an alert or a config change, stored as data) in words, on the reader's
 * clock: a countdown is to now, not to when the event happened.
 */
export function eventText(e, now = Date.now()) {
  const who = e.account ? `${accountName(e.account)}${e.account.email ? ` (${e.account.email})` : ''}: ` : '';
  const until = (at) => (at > now ? countdown(at, now) : null);
  switch (e.kind) {
    case 'exhausted': return `${who}${e.window} exhausted${until(e.resetsAt) ? ` · resets in ${until(e.resetsAt)}` : ''}`;
    case 'seat-problem': return `${who}${e.problem}`;
    case 'extra-reset': return `${who}extra reset announced${until(e.at) ? ` · in ${until(e.at)}` : ''}${e.url ? ` · ${e.url}` : ''}`;
    case 'config': return `config ${e.key} = ${JSON.stringify(e.value)} ${e.outcome === 'requested' ? 'requested'
      : e.outcome === 'applied' ? `applied by ${e.host}` : `refused by ${e.host}: ${e.error}`}`;
    default: return e.kind;
  }
}

/** The events the Events tab lists: those newer than the last visit (`seenAt`); read ones are cleared. */
export const unreadEvents = (events = [], seenAt = null) => events.filter((e) => !seenAt || e.at > seenAt);

const tokensOf = (r) => (r.input ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0) + (r.output ?? 0);

/** A token count as people read it: 950, 12k, 3.4M, 1.2B. */
export function tokenText(n) {
  if (!(n > 0)) return '0';
  for (const [v, s] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) if (n >= v) return `${(n / v).toFixed(n >= 10 * v ? 0 : 1).replace(/\.0$/, '')}${s}`;
  return String(Math.round(n));
}

/** Agent time as people read it: 45m, 3.5h, 120h. */
export const hoursText = (ms) => (!(ms > 0) ? '0' : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(ms < 36000000 ? 1 : 0).replace(/\.0$/, '')}h`);

/**
 * The Usage tab from the store's report (scripts/dashboard/usage-store.mjs report): totals, one
 * bar per day of the range (every day, empty ones too) split by agent, and the ranked lists.
 * `active` is agent time: turns' durations summed, so parallel sessions add up.
 */
export function usageView(report, now = Date.now(), tzOffsetMin = 0) {
  if (!report) return null;
  const byDay = new Map();
  let tokens = 0, active = 0, turns = 0, input = 0, cacheRead = 0, cacheWrite = 0;
  for (const d of report.daily ?? []) {
    const row = byDay.get(d.day) ?? { day: d.day, claude: 0, codex: 0, active: 0 };
    row[d.agent] = (row[d.agent] ?? 0) + tokensOf(d);
    row.active += d.active_ms ?? 0;
    byDay.set(d.day, row);
    tokens += tokensOf(d); active += d.active_ms ?? 0; turns += d.turns ?? 0;
    input += d.input ?? 0; cacheRead += d.cache_read ?? 0; cacheWrite += d.cache_write ?? 0;
  }
  // A 24 h report is by hour ('YYYY-MM-DDTHH'), any other by day: every bucket of the range, empty ones too.
  const hourly = report.unit === 'hour';
  const ms = hourly ? 3600000 : 86400000;
  const days = [];
  const today = Math.floor((now + tzOffsetMin * 60000) / ms);
  for (let i = (hourly ? 24 : report.days) - 1; i >= 0; i--) {
    const day = new Date((today - i) * ms).toISOString().slice(0, hourly ? 13 : 10);
    days.push(byDay.get(day) ?? { day, claude: 0, codex: 0, active: 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.claude + d.codex));
  const list = (rows) => rows.map((r) => ({ name: r.k ?? 'unknown', tokens: tokensOf(r), share: tokens ? tokensOf(r) / tokens : 0,
    active: r.active_ms ?? 0, turns: r.turns ?? 0 }));
  return {
    unit: hourly ? 'hour' : 'day',
    totals: { tokens, active, turns, costUsd: report.costUsd ?? null, cacheHit: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : null },
    days: days.map((d) => ({ ...d, claudePct: (d.claude / max) * 100, codexPct: (d.codex / max) * 100 })),
    projects: list(report.projects ?? []), models: list(report.models ?? []), machines: list(report.machines ?? []),
  };
}
