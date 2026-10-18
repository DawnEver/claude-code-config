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

/** Example data for `?mock`: rendering only, no gateway involved. */
export function mockDashboard(now = Date.now()) {
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
  ] };
}
