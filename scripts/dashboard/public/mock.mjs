// scripts/dashboard/public/mock.mjs — example data for `?mock` and the tests: rendering only, no gateway.
// Built from the shared tables (config keys), so it cannot drift from what a real snapshot carries.

import { configKeysMeta } from './shared/config-keys.mjs';

/** Example data for `?mock`: rendering only, no gateway involved. */
export function mockDashboard(now = Date.now()) {
  const H = 3600000;
  const t = (sec) => new Date(now - sec * 1000).toISOString();
  const acct = { claude: 'claude:a', codex: 'codex:b' };
  const s = (hostId, stale, id, agent, project, branch, status, sec, topic, seat = null, name = null, unread = 0, mention = false) =>
    ({ id, hostId, agent, name, project, branch, seat, status, unread, mention, lastActivityAt: t(sec), stale, topic, account: acct[agent] });
  return { schemaVersion: 1, generatedAt: t(0), mock: true, hosts: [
    { id: 'host-a', online: true, lastSeen: t(4), config: { editable: { 'bridge.idleCloseMinutes': 30, 'bridge.deleteClosedAfterHours': 24, 'bridge.dashboard.everySeconds': 15, 'bridge.projects.backend-api.projectInTitle': 'always' }, localOverrides: [], facts: { bridge: true, allowedUsers: 1, approvalsFromTelegram: false, codexSources: ['cli'], dashboardError: null } }, sessions: [
      { ...s('host-a', false, '0b6c4e1a-1111', 'claude', 'backend-api', 'feature/auth', 'working', 12, { url: 'https://t.me/c/1000000001/12', closed: false }, 'team-a', 'OAuth token refresh', 3), repo: 'github.com/example/backend-api' },
      s('host-a', false, '019a7f20-2222', 'codex', 'frontend', 'main', 'needs_approval', 40, { url: 'https://t.me/c/1000000001/13', closed: false }, null, 'Landing page redesign', 5, true)],
      resources: { cpu: 42, cores: 16, cpuModel: 'AMD Ryzen 9 7950X', mem: { used: 21e9, total: 34e9, type: 'DDR5' }, gpus: [{ name: 'NVIDIA RTX 4090', util: 87, memUsed: 18e9, memTotal: 25.7e9 }] } },
    { id: 'host-b', online: true, lastSeen: t(9), config: { editable: { 'bridge.idleCloseMinutes': 30, 'bridge.deleteClosedAfterHours': 24, 'bridge.dashboard.everySeconds': 15, 'bridge.projects.backend-api.projectInTitle': 'always' }, localOverrides: ['bridge.dashboard.everySeconds'], facts: { bridge: true, allowedUsers: 1, approvalsFromTelegram: false, codexSources: ['cli'], dashboardError: null } }, sessions: [
      s('host-b', false, '7d1e9b3c-3333', 'claude', 'refactor', 'refactor/core', 'idle', 900, { url: 'https://t.me/c/1000000002/7', closed: true }, null, 'Split the parser module', 1),
      { ...s('host-b', false, '019a8c41-4444', 'codex', 'tests', 'main', 'working', 3, null), provider: 'deepseek', account: 'api:deepseek:default' }],
      resources: { cpu: 7, cores: 10, cpuModel: 'Apple M2 Pro', mem: { used: 9e9, total: 17e9, type: 'LPDDR5' }, gpus: [] } },
    { id: 'host-c', online: false, lastSeen: t(5400), sessions: [
      s('host-c', true, 'aa12bb34-5555', 'claude', 'backend-api', 'main', 'working', 5500, null)] },
  ], configKeys: configKeysMeta(), configPending: [{ id: 'c1', key: 'bridge.deleteClosedAfterHours', value: 48, at: t(20), host: 'host-a' }], events: [
    { at: t(40), kind: 'exhausted', account: { agent: 'codex', label: null, email: 'bob@example.com' }, window: '5h', resetsAt: now + 3 * H },
    { at: t(7200), kind: 'config', key: 'bridge.idleCloseMinutes', value: 30, outcome: 'applied', host: 'host-b' },
  ], accounts: [
    { key: 'claude:a', kind: 'quota', agent: 'claude', label: 'team-a', email: 'alice@example.com', detail: 'Team A · Team Premium', problems: [],
      at: now - 60000, hosts: ['host-a', 'host-c'], resetCredits: null, extraReset: null, windows: [
        { k: '5h', used: 26, resetsAt: now + 24 * 60000, windowMs: 5 * H, cells: [0.4, 0.8, 1.2, 0.9, 1.6, 2, 1.1, 0.7, 0.9, null], forecast: { atReset: 31, eta: null, short: false } },
        { k: '7d', used: 45, resetsAt: now + 129 * H, windowMs: 168 * H, cells: [0.6, 1.4, 1.8, 0.9, 1.1, 2.2, 2.6, 2.4, 2.5, null, null, null, null, null], forecast: { atReset: 118, eta: now + 47 * H, short: true } }] },
    { key: 'codex:b', kind: 'quota', agent: 'codex', label: null, email: 'bob@example.com', detail: 'Pro', problems: [], at: now - 30000, hosts: ['host-a', 'host-b'],
      resetCredits: { count: 1, expiries: [now + 3 * 24 * H] }, extraReset: null, windows: [
        { k: '5h', used: 100, resetsAt: now + 3 * H, windowMs: 5 * H, cells: [-1, -1, 30, 40, null, null, null, null, null, null], forecast: null },
        { k: '7d', used: 12, resetsAt: now + 100 * H, windowMs: 168 * H, cells: [0.4, 0.7, 0.6, 0.9, 0.5, null, null, null, null, null, null, null, null, null], forecast: { atReset: 30, eta: null, short: false } }] },
    { key: 'api:deepseek:default', kind: 'balance', provider: 'deepseek', label: null, at: now - 300000, error: null, hosts: ['host-b'],
      balances: [{ currency: 'CNY', amount: 457.22 }, { currency: 'USD', amount: 2 }] },
  ], repos: [
    { key: 'github.com/example/backend-api', forge: 'github', name: 'example/backend-api', url: 'https://github.com/example/backend-api', private: false,
      defaultBranch: 'main', pushedAt: new Date(now - 2 * H).toISOString(), at: now - 120000, error: null, hosts: ['host-a', 'host-b'],
      branches: [
        { name: 'main', sha: 'a1', at: new Date(now - 2 * H).toISOString(), author: 'alice', ci: 'success' },
        { name: 'feature/auth', sha: 'b2', at: new Date(now - 3 * H).toISOString(), author: 'alice', ci: 'failure' }],
      pulls: [{ number: 42, title: 'OAuth token refresh', url: 'https://github.com/example/backend-api/pull/42', draft: false, author: 'alice',
        head: 'feature/auth', base: 'main', review: 'required', conflict: false, ci: 'failure', updatedAt: new Date(now - 3 * H).toISOString() }] },
    { key: 'git.example.org/team/frontend', forge: 'gitea', name: 'team/frontend', url: 'https://git.example.org/team/frontend', private: true,
      defaultBranch: 'main', pushedAt: new Date(now - 26 * H).toISOString(), at: now - 120000, error: null, hosts: ['host-a'],
      branches: [{ name: 'main', sha: 'c3', at: new Date(now - 26 * H).toISOString(), author: 'bob', ci: 'pending' }], pulls: [] },
  ] };
}
