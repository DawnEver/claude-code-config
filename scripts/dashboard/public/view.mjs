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

// ── Quota (per account; computed by the host, scripts/bridge/fleet.mjs accountModels) ──

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
    return { k: w.k, renewed, used: renewed ? 0 : w.used, resetsAt: renewed ? null : w.resetsAt,
      pace: renewed ? 0 : Math.min(100, Math.max(0, (1 - (w.resetsAt - now) / w.windowMs) * 100)),
      cells: renewed ? [] : w.cells, forecast: renewed || stale ? null : w.forecast };
  });
  const live = windows.filter((w) => !w.renewed);
  const bind = live.filter((w) => w.forecast?.short).sort((x, y) => x.forecast.eta - y.forecast.eta)[0]
    ?? [...live].sort((x, y) => y.used - x.used)[0] ?? null;
  const verdict = !bind ? 'none' : bind.used >= 100 ? 'exhausted' : bind.forecast?.short ? 'short' : 'ok';
  return { ...a, stale, windows, bind, verdict, left: bind ? Math.round(100 - bind.used) : null };
}

/** Accounts that need the human: a window exhausted, or projected to run out before its reset. */
export const quotaAlerts = (snapshot, now = Date.now()) =>
  (snapshot.accounts ?? []).map((a) => quotaView(a, now)).filter((q) => q.verdict === 'exhausted' || q.verdict === 'short');

/**
 * The two tabs below the needs-you card, each answering one question: what runs (sessions)
 * and will the quota last (quota). `alert` marks the quota tab while an account needs the
 * human; the card above lists it whichever tab is open.
 */
export function tabs(snapshot, now = Date.now()) {
  const accounts = snapshot.accounts ?? [];
  return { sessions: sessionsOf(snapshot).length, quota: accounts.length, alert: quotaAlerts(snapshot, now).length > 0,
    show: accounts.length > 0 };
}

/** Example data for `?mock`: rendering only, no gateway involved. */
export function mockDashboard(now = Date.now()) {
  const H = 3600000;
  const t = (sec) => new Date(now - sec * 1000).toISOString();
  const s = (hostId, stale, id, agent, project, branch, status, sec, topic, seat = null) =>
    ({ id, hostId, agent, project, branch, seat, status, lastActivityAt: t(sec), stale, topic });
  return { schemaVersion: 1, generatedAt: t(0), mock: true, hosts: [
    { id: 'host-a', online: true, lastSeen: t(4), sessions: [
      s('host-a', false, '0b6c4e1a-1111', 'claude', 'backend-api', 'feature/auth', 'working', 12, { url: 'https://t.me/c/1000000001/12', closed: false }, 'team-a'),
      s('host-a', false, '019a7f20-2222', 'codex', 'frontend', 'main', 'needs_approval', 40, { url: 'https://t.me/c/1000000001/13', closed: false })] },
    { id: 'host-b', online: true, lastSeen: t(9), sessions: [
      s('host-b', false, '7d1e9b3c-3333', 'claude', 'refactor', 'refactor/core', 'idle', 900, { url: 'https://t.me/c/1000000002/7', closed: true }),
      s('host-b', false, '019a8c41-4444', 'codex', 'tests', 'main', 'working', 3, null)] },
    { id: 'host-c', online: false, lastSeen: t(5400), sessions: [
      s('host-c', true, 'aa12bb34-5555', 'claude', 'backend-api', 'main', 'working', 5500, null)] },
  ], accounts: [
    { key: 'claude:a', agent: 'claude', label: 'team-a', email: 'alice@example.com', detail: 'Team A · Team Premium', problems: [],
      at: now - 60000, hosts: ['host-a', 'host-c'], resetCredits: null, extraReset: null, windows: [
        { k: '5h', used: 26, resetsAt: now + 24 * 60000, windowMs: 5 * H, cells: [0.4, 0.8, 1.2, 0.9, 1.6, 2, 1.1, 0.7, 0.9, null], forecast: { atReset: 31, eta: null, short: false } },
        { k: '7d', used: 45, resetsAt: now + 129 * H, windowMs: 168 * H, cells: [0.6, 1.4, 1.8, 0.9, 1.1, 2.2, 2.6, 2.4, 2.5, null, null, null, null, null], forecast: { atReset: 118, eta: now + 47 * H, short: true } }] },
    { key: 'codex:b', agent: 'codex', label: null, email: 'bob@example.com', detail: 'Pro', problems: [], at: now - 30000, hosts: ['host-b'],
      resetCredits: { count: 1, expiries: [now + 3 * 24 * H] }, extraReset: null, windows: [
        { k: '5h', used: 8, resetsAt: now + 3 * H, windowMs: 5 * H, cells: [-1, -1, 0.3, 0.5, null, null, null, null, null, null], forecast: { atReset: 14, eta: null, short: false } },
        { k: '7d', used: 12, resetsAt: now + 100 * H, windowMs: 168 * H, cells: [0.4, 0.7, 0.6, 0.9, 0.5, null, null, null, null, null, null, null, null, null], forecast: { atReset: 30, eta: null, short: false } }] },
  ] };
}
