// scripts/fleet-gateway/public/view.mjs — pure view logic of the Mini App (no DOM), shared by
// app.js and the tests. Status comes from the gateway as reported by the host; the only thing
// the view adds is freshness: a session of an offline host reads `Stale`, never its last state.

export const STATUS_LABELS = { working: 'Working', idle: 'Idle', needs_approval: 'Needs Approval', needs_input: 'Needs Input',
  ended: 'Ended', unknown: 'Unknown', stale: 'Stale' };
export const ATTENTION = ['needs_approval', 'needs_input'];

export const displayStatus = (s) => (s.stale ? 'stale' : s.status);

export function sessionsOf(fleet) {
  return fleet.hosts.flatMap((h) => h.sessions);
}

/** Distinct option values per filter, from the data itself. */
export function filterOptions(fleet) {
  const all = sessionsOf(fleet);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  return { host: fleet.hosts.map((h) => h.id), agent: uniq(all.map((s) => s.agent)),
    project: uniq(all.map((s) => s.project)), status: uniq(all.map(displayStatus)) };
}

/** Hosts with their sessions narrowed by `filters` ({host, agent, project, status}; '' = all). */
export function applyFilters(fleet, filters) {
  const narrowed = filters.agent || filters.project || filters.status;
  return fleet.hosts.filter((h) => !filters.host || h.id === filters.host).map((h) => ({ ...h,
    sessions: h.sessions.filter((s) => (!filters.agent || s.agent === filters.agent)
      && (!filters.project || s.project === filters.project) && (!filters.status || displayStatus(s) === filters.status)) }))
    .filter((h) => !narrowed || h.sessions.length);
}

export function stats(fleet) {
  const live = sessionsOf(fleet).filter((s) => !s.stale);
  return { hostsOnline: fleet.hosts.filter((h) => h.online).length, hosts: fleet.hosts.length,
    working: live.filter((s) => s.status === 'working').length,
    attention: live.filter((s) => ATTENTION.includes(s.status)).length };
}

export function hostSummary(h) {
  const n = (agent) => h.sessions.filter((s) => s.agent === agent).length;
  return { claude: n('claude'), codex: n('codex'),
    active: h.sessions.filter((s) => !s.stale && s.status === 'working').length,
    attention: h.sessions.filter((s) => !s.stale && ATTENTION.includes(s.status)).length };
}

export function ago(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Example data for `?mock`: rendering only, no gateway involved. */
export function mockFleet(now = Date.now()) {
  const t = (sec) => new Date(now - sec * 1000).toISOString();
  const s = (hostId, stale, id, agent, project, branch, status, sec, topic) =>
    ({ id, hostId, agent, project, branch, seat: null, status, lastActivityAt: t(sec), stale, topic });
  return { schemaVersion: 1, generatedAt: t(0), mock: true, hosts: [
    { id: 'host-a', online: true, lastSeen: t(4), sessions: [
      s('host-a', false, '0b6c4e1a-1111', 'claude', 'backend-api', 'feature/auth', 'working', 12, { url: 'https://t.me/c/1000000001/12', closed: false }),
      s('host-a', false, '019a7f20-2222', 'codex', 'frontend', 'main', 'needs_approval', 40, null)] },
    { id: 'host-b', online: true, lastSeen: t(9), sessions: [
      s('host-b', false, '7d1e9b3c-3333', 'claude', 'refactor', 'refactor/core', 'idle', 900, { url: 'https://t.me/c/1000000002/7', closed: true }),
      s('host-b', false, '019a8c41-4444', 'codex', 'tests', 'main', 'working', 3, null)] },
    { id: 'host-c', online: false, lastSeen: t(5400), sessions: [
      s('host-c', true, 'aa12bb34-5555', 'claude', 'backend-api', 'main', 'working', 5500, null)] },
  ] };
}
