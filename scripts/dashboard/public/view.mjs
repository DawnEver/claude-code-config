// scripts/dashboard/public/view.mjs — pure view logic of the Mini App (no DOM), shared by
// app.js and the tests. Status comes from the gateway as reported by the host; the only thing
// the view adds is freshness: a session of an offline host reads `Stale`, never its last state.
// The page answers, in order: does anything need me, what is running, where.

export const STATUS_LABELS = { working: 'Working', idle: 'Idle', needs_approval: 'Needs approval', needs_input: 'Needs input',
  ended: 'Ended', unknown: 'Unknown', stale: 'Stale' };
export const ATTENTION = ['needs_approval', 'needs_input'];
/** Most urgent first: what needs the human, then what runs, then the rest. */
const RANK = { needs_approval: 0, needs_input: 1, working: 2, idle: 3, unknown: 4, ended: 5, stale: 6 };

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

export const sortSessions = (sessions) => [...sessions].sort((a, b) =>
  (RANK[displayStatus(a)] ?? 9) - (RANK[displayStatus(b)] ?? 9) || String(a.project).localeCompare(String(b.project)));

/** Distinct host and project values, and how many sessions each status chip holds. */
export function filterOptions(snapshot) {
  const all = sessionsOf(snapshot);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const counts = Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, all.filter((s) => g.has(displayStatus(s))).length]));
  return { host: snapshot.hosts.map((h) => h.id), agent: uniq(all.map((s) => s.agent)), project: uniq(all.map((s) => s.project)), counts };
}

/**
 * Hosts with their sessions narrowed by `filters` ({host, agent, project: '' = all; group: a
 * GROUPS key}) and sorted by urgency; online hosts first. A narrowing filter drops empty hosts.
 */
export function applyFilters(snapshot, filters) {
  const group = GROUPS[filters.group] ?? GROUPS.all;
  const narrowed = filters.agent || filters.project || (filters.group && filters.group !== 'all');
  return snapshot.hosts.filter((h) => !filters.host || h.id === filters.host).map((h) => ({ ...h,
    sessions: sortSessions(h.sessions.filter((s) => (!filters.agent || s.agent === filters.agent)
      && (!filters.project || s.project === filters.project) && group.has(displayStatus(s)))) }))
    .filter((h) => !narrowed || h.sessions.length)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
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
  const m = Math.max(0, Math.floor((now - at) / 60000));
  return `${word} ${m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`}`;
}

/**
 * The sessions view grouped `by` 'host' (the filtered hosts as they are) or 'project': one group
 * per project across hosts, by name, sessions by urgency; `online` when any of its hosts is.
 */
export function groupSessions(hosts, by = 'host') {
  if (by !== 'project') return hosts;
  const groups = new Map();
  for (const h of hosts) for (const s of h.sessions) {
    const id = s.project ?? 'unknown project';
    const g = groups.get(id) ?? { id, online: false, sessions: [] };
    g.online ||= h.online;
    g.sessions.push(s);
    groups.set(id, g);
  }
  return [...groups.values()].map((g) => ({ ...g, sessions: sortSessions(g.sessions) })).sort((a, b) => a.id.localeCompare(b.id));
}

export function stats(snapshot) {
  const live = sessionsOf(snapshot).filter((s) => !s.stale);
  return { hostsOnline: snapshot.hosts.filter((h) => h.online).length, hosts: snapshot.hosts.length,
    working: live.filter((s) => s.status === 'working').length,
    attention: live.filter((s) => ATTENTION.includes(s.status)).length };
}

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

/** A reading older than this is a floor on use (`≥`) and is never projected from. */
export const QUOTA_STALE_MS = 15 * 60000;

/** Time to `ms` in its two largest units: `4d 7h`, `3h 15m`, `12m`. */
export function countdown(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((ms - now) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${min}m` : `${min}m`;
}

/**
 * One account as the page reads it, on the reader's clock: each window's use, the even-spend
 * pace by now, and the forecast (none from a stale reading); then the binding window — the one
 * that runs out soonest, else the fullest — and its verdict.
 */
export function quotaView(a, now = Date.now()) {
  const stale = !a.at || now - a.at > QUOTA_STALE_MS;
  const windows = a.windows.map((w) => {
    const renewed = !w.resetsAt || w.resetsAt <= now;
    return { k: w.k, renewed, used: renewed ? 0 : w.used, resetsAt: renewed ? null : w.resetsAt, windowMs: w.windowMs,
      pace: renewed ? 0 : Math.min(100, Math.max(0, (1 - (w.resetsAt - now) / w.windowMs) * 100)),
      cells: renewed ? [] : w.cells, forecast: renewed || stale ? null : w.forecast };
  });
  const live = windows.filter((w) => !w.renewed);
  const bind = live.filter((w) => w.forecast?.short).sort((x, y) => x.forecast.eta - y.forecast.eta)[0]
    ?? [...live].sort((x, y) => y.used - x.used)[0] ?? null;
  const verdict = !bind ? 'none' : bind.used >= 100 ? 'exhausted' : bind.forecast?.short ? 'short' : 'ok';
  return { ...a, stale, windows, bind, verdict, left: bind ? Math.round(100 - bind.used) : null };
}

export const accountName = (q) => `${q.agent === 'claude' ? 'Claude' : 'Codex'}${q.label ? ` · ${q.label}` : ''}`;

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
export function windowLabel(w, stale) {
  if (w.renewed) return { text: 'unused', title: 'new window, nothing spent yet', stale: false };
  const left = Math.max(0, Math.round(100 - w.used));
  const ceiling = stale && left > 0;
  return { text: `${ceiling ? '≤' : ''}${left}%`, title: ceiling ? `at most ${left}% left (stale reading)` : `${left}% left`, stale: ceiling };
}

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
 * The quota alerts a change of `q` warrants against what was last alerted for its account
 * (`prev`): a window turning exhausted (a forecast run-out is shown, never alerted), a new seat problem, a newly announced
 * extra reset. Returns the alert texts and the state to remember. Events, not state: an
 * unchanged condition alerts once; recovering clears it, so a relapse alerts again.
 */
export function quotaAlertsFor(prev, q, now = Date.now()) {
  const who = `${accountName(q)}${q.email ? ` (${q.email})` : ''}`;
  const texts = [];
  if (q.verdict === 'exhausted' && prev?.verdict !== 'exhausted') texts.push(`${who}: ${verdictText(q, { now })}`);
  for (const p of q.problems) if (!prev?.problems?.includes(p)) texts.push(`${who}: ${p}`);
  const extraAt = q.extraReset ? q.extraReset.at ?? 0 : null;
  if (extraAt !== null && prev?.extraAt !== extraAt) {
    texts.push(`${who}: extra reset announced${q.extraReset.at ? ` · in ${countdown(q.extraReset.at, now)}` : ''}${q.extraReset.url ? ` · ${q.extraReset.url}` : ''}`);
  }
  return { texts, state: { verdict: q.verdict, problems: [...q.problems], extraAt } };
}

/** One alert's identity: the account, its verdict and the window period. A new period is a new alert. */
export const alertKey = (q) => JSON.stringify([q.key, q.verdict, q.bind?.k ?? null, q.bind?.resetsAt ?? null]);

/** A forecast run-out this close is an alert in the needs-you card; a farther one is only shown. */
export const RUNOUT_ALERT_MS = 3600000;

/**
 * Accounts that need the human: a window exhausted, or forecast to run out within
 * RUNOUT_ALERT_MS; minus the alerts already read (`read`: alert keys).
 */
export const quotaAlerts = (snapshot, now = Date.now(), read = []) =>
  (snapshot.accounts ?? []).map((a) => quotaView(a, now))
    .filter((q) => (q.verdict === 'exhausted' || (q.verdict === 'short' && q.bind.forecast.eta - now <= RUNOUT_ALERT_MS))
      && !read.includes(alertKey(q)));

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
    hosts: hosts.map((h) => ({ id: h.id, online: h.online, facts: h.config.facts })),
  };
}

/** Every account as the reader sees it, by key: what a session (its `account`) or a host refers to. */
export const accountIndex = (snapshot, now = Date.now()) => new Map((snapshot.accounts ?? []).map((a) => [a.key, quotaView(a, now)]));

/** An account in a few characters: the seat alias, else the email's name, else the agent. */
export const accountTag = (q) => q.label ?? q.email?.split('@')[0] ?? (q.agent === 'claude' ? 'Claude' : 'Codex');

/**
 * Quota by host: each host with the accounts it runs. An account is one budget however many
 * hosts spend it, so a shared one says where else it runs (`sharedWith`) rather than reading as
 * a second budget: its full card sits on the first host in order (online first), elsewhere
 * `refTo` names that host. Online hosts first; a host without accounts is left out.
 */
export function quotaByHost(snapshot, now = Date.now()) {
  const accounts = [...accountIndex(snapshot, now).values()];
  const hosts = [...snapshot.hosts].sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
  const owner = new Map();
  for (const h of hosts) for (const q of accounts) if (q.hosts?.includes(h.id) && !owner.has(q.key)) owner.set(q.key, h.id);
  return hosts.map((h) => ({ id: h.id, online: h.online, accounts: accounts.filter((q) => q.hosts?.includes(h.id))
      .map((q) => ({ ...q, sharedWith: q.hosts.filter((x) => x !== h.id), refTo: owner.get(q.key) === h.id ? null : owner.get(q.key) })) }))
    .filter((h) => h.accounts.length);
}

/**
 * The tabs below the needs-you card, each answering one question: what runs (sessions), will
 * the quota last (quota), what happened (events: the alerts, as history). `alert` marks the
 * quota tab while an unread quota alert stands; `unseen` counts events newer than `seenAt`;
 * `events` counts what the Events tab lists (unread when it was opened, `shownFrom`).
 */
export function tabs(snapshot, now = Date.now(), seenAt = null, read = [], shownFrom = seenAt) {
  const accounts = snapshot.accounts ?? [];
  const events = snapshot.events ?? [];
  return { sessions: sessionsOf(snapshot).length, quota: accounts.length, alert: quotaAlerts(snapshot, now, read).length > 0,
    events: unreadEvents(events, shownFrom).length, unseen: events.filter((e) => !seenAt || e.at > seenAt).length,
    show: accounts.length > 0 || events.length > 0 };
}

/** The events the Events tab lists: those newer than the last visit (`seenAt`); read ones are cleared. */
export const unreadEvents = (events = [], seenAt = null) => events.filter((e) => !seenAt || e.at > seenAt);

/** Example data for `?mock`: rendering only, no gateway involved. */
export function mockDashboard(now = Date.now()) {
  const H = 3600000;
  const t = (sec) => new Date(now - sec * 1000).toISOString();
  const acct = { claude: 'claude:a', codex: 'codex:b' };
  const s = (hostId, stale, id, agent, project, branch, status, sec, topic, seat = null) =>
    ({ id, hostId, agent, project, branch, seat, status, lastActivityAt: t(sec), stale, topic, account: acct[agent] });
  return { schemaVersion: 1, generatedAt: t(0), mock: true, hosts: [
    { id: 'host-a', online: true, lastSeen: t(4), config: { editable: { 'bridge.idleCloseMinutes': 30, 'bridge.deleteClosedAfterHours': 24, 'bridge.dashboard.everySeconds': 15, 'bridge.projects.backend-api.projectInTitle': 'always' }, localOverrides: [], facts: { bridge: true, allowedUsers: 1, approvalsFromTelegram: false, codexSources: ['cli'], dashboardError: null } }, sessions: [
      s('host-a', false, '0b6c4e1a-1111', 'claude', 'backend-api', 'feature/auth', 'working', 12, { url: 'https://t.me/c/1000000001/12', closed: false }, 'team-a'),
      s('host-a', false, '019a7f20-2222', 'codex', 'frontend', 'main', 'needs_approval', 40, { url: 'https://t.me/c/1000000001/13', closed: false })] },
    { id: 'host-b', online: true, lastSeen: t(9), config: { editable: { 'bridge.idleCloseMinutes': 30, 'bridge.deleteClosedAfterHours': 24, 'bridge.dashboard.everySeconds': 15, 'bridge.projects.backend-api.projectInTitle': 'always' }, localOverrides: ['bridge.dashboard.everySeconds'], facts: { bridge: true, allowedUsers: 1, approvalsFromTelegram: false, codexSources: ['cli'], dashboardError: null } }, sessions: [
      s('host-b', false, '7d1e9b3c-3333', 'claude', 'refactor', 'refactor/core', 'idle', 900, { url: 'https://t.me/c/1000000002/7', closed: true }),
      s('host-b', false, '019a8c41-4444', 'codex', 'tests', 'main', 'working', 3, null)] },
    { id: 'host-c', online: false, lastSeen: t(5400), sessions: [
      s('host-c', true, 'aa12bb34-5555', 'claude', 'backend-api', 'main', 'working', 5500, null)] },
  ], configKeys: [
    { key: 'bridge.idleCloseMinutes', label: 'Close an idle Topic after (minutes, 0 = never)', min: 0, max: 1440 },
    { key: 'bridge.deleteClosedAfterHours', label: 'Delete a closed Topic after (hours, 0 = never)', min: 0, max: 720 },
    { key: 'bridge.dashboard.everySeconds', label: 'Push to the dashboard every (seconds)', min: 5, max: 3600 },
    { key: 'bridge.projects.*.projectInTitle', label: 'Project name in Topic titles', options: ['always', 'main', 'never'] },
  ], configPending: [{ id: 'c1', key: 'bridge.deleteClosedAfterHours', value: 48, at: t(20), host: 'host-a' }], events: [
    { at: t(40), text: 'Claude · team-a (alice@example.com): 7d runs out in 1d 23h · resets in 5d 9h' },
    { at: t(7200), text: 'Codex (bob@example.com): extra reset announced · in 2h 0m' },
  ], accounts: [
    { key: 'claude:a', agent: 'claude', label: 'team-a', email: 'alice@example.com', detail: 'Team A · Team Premium', problems: [],
      at: now - 60000, hosts: ['host-a', 'host-c'], resetCredits: null, extraReset: null, windows: [
        { k: '5h', used: 26, resetsAt: now + 24 * 60000, windowMs: 5 * H, cells: [0.4, 0.8, 1.2, 0.9, 1.6, 2, 1.1, 0.7, 0.9, null], forecast: { atReset: 31, eta: null, short: false } },
        { k: '7d', used: 45, resetsAt: now + 129 * H, windowMs: 168 * H, cells: [0.6, 1.4, 1.8, 0.9, 1.1, 2.2, 2.6, 2.4, 2.5, null, null, null, null, null], forecast: { atReset: 118, eta: now + 47 * H, short: true } }] },
    { key: 'codex:b', agent: 'codex', label: null, email: 'bob@example.com', detail: 'Pro', problems: [], at: now - 30000, hosts: ['host-a', 'host-b'],
      resetCredits: { count: 1, expiries: [now + 3 * 24 * H] }, extraReset: null, windows: [
        { k: '5h', used: 100, resetsAt: now + 3 * H, windowMs: 5 * H, cells: [-1, -1, 30, 40, null, null, null, null, null, null], forecast: null },
        { k: '7d', used: 12, resetsAt: now + 100 * H, windowMs: 168 * H, cells: [0.4, 0.7, 0.6, 0.9, 0.5, null, null, null, null, null, null, null, null, null], forecast: { atReset: 30, eta: null, short: false } }] },
  ] };
}
