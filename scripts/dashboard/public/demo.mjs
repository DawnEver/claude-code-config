// scripts/dashboard/public/demo.mjs — demo mode: the live snapshot with every identity masked in
// the browser, so the real dashboard can be shown without naming anyone. Pure: no DOM.
//
// Rules, not a mapping table: each kind of identity is numbered by first appearance and keeps its
// name for the masker's life, so names stay stable across polls and cross-references (session ->
// account -> host) still resolve. Statuses, times and quota numbers pass through untouched.
//
// Events are data (registry.mjs), so each of their fields is masked by its role. The free text
// left — a seat problem (bridge/quota.mjs) is rebuilt from its template; anything else, such as a
// host's error, is masked by shape (emails, ids, config keys) plus every name already masked.

const letter = (n) => String.fromCharCode(96 + n);
const KEEP_BRANCHES = ['main', 'master'];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HEX_ID = /\b[0-9a-f]{8,}(?:-[0-9a-f]+)*\b/gi;
const PROJECT_KEY = /^(bridge\.projects\.)([A-Za-z0-9_-]+)(\.projectInTitle)$/;
const PROBLEM = /^(no subscription login|wrong account|wrong team), expected (.+)$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One namespace: real value -> its masked name, numbered in order of first appearance. */
function namer(format) {
  const map = new Map();
  const name = (v) => {
    if (v == null) return v;
    if (!map.has(v)) map.set(v, format(map.size + 1, v));
    return map.get(v);
  };
  name.map = map;
  return name;
}

export function demoMasker() {
  const host = namer((n) => `Workstation ${n}`);
  const email = namer((n) => `user${n}@example.com`);
  const project = namer((n) => `project-${letter(n)}`);
  const branchN = namer((n) => `branch-${n}`);
  const session = namer((n) => `session-${n}`);
  const sessionTitle = namer((n) => `Task ${n}`);
  const chat = namer((n) => String(1000000000 + n));
  const account = namer((n, k) => `${k.split(':')[0]}:account-${n}`);
  // A seat alias and its account's org share one letter: team-a sits in Team A.
  const team = namer(letter);
  const seat = (v) => (v == null ? v : `team-${team(v)}`);
  const orgs = namer((n, v) => `Team ${team(v).toUpperCase()}`);
  const org = (v, alias) => {
    if (alias != null && !team.map.has(v)) team.map.set(v, team(alias));
    return orgs(v);
  };

  const mail = (v) => (v == null ? v : email(v.toLowerCase()));
  const branch = (v) => (v == null || KEEP_BRANCHES.includes(v) ? v : branchN(v));
  const configKey = (k) => k.replace(PROJECT_KEY, (_, a, p, b) => a + project(p) + b);
  const topicUrl = (u) => u?.replace(/(t\.me\/c\/)(\d+)\//, (_, p, id) => `${p}${chat(id)}/`);
  const who = (w) => w.split(' · ').map((p) => (p === 'not logged in' ? p : p.includes('@') ? p.replace(EMAIL, mail) : org(p))).join(' · ');

  /** Text from no known template: mask by shape, then every name already masked, longest first. */
  const fallback = (t) => {
    let out = t.replace(EMAIL, mail)
      .replace(/bridge\.projects\.[A-Za-z0-9_-]+\.projectInTitle/g, configKey)
      .replace(HEX_ID, (id) => (/[a-f]/i.test(id) && /\d/.test(id) ? session(id) : id));
    const names = [host, project, branchN, session, orgs].flatMap((f) => [...f.map])
      .concat([...team.map.keys()].filter((k) => !orgs.map.has(k)).map((k) => [k, seat(k)]))
      .sort((x, y) => y[0].length - x[0].length);
    for (const [real, fake] of names) out = out.replace(new RegExp(`(?<![\\w.@/-])${escape(real)}(?![\\w@/-])`, 'g'), fake);
    return out;
  };
  const problem = (t) => t.replace(PROBLEM, (_, what, w) => `${what}, expected ${who(w)}`);
  const text = (t) => {
    if (typeof t !== 'string') return t;
    return PROBLEM.test(t) ? problem(t) : fallback(t);
  };

  const mask = (snap) => {
    // Structured fields first: they fix the numbering the free text then reuses.
    const hosts = (snap.hosts ?? []).map((h) => ({ ...h, id: host(h.id),
      sessions: (h.sessions ?? []).map((s) => ({ ...s, id: session(s.id), name: sessionTitle(s.name), hostId: host(s.hostId), project: project(s.project),
        branch: branch(s.branch), seat: seat(s.seat), account: account(s.account), topic: s.topic && { ...s.topic, url: topicUrl(s.topic.url),
          ...(s.topic.firstUnreadUrl ? { firstUnreadUrl: topicUrl(s.topic.firstUnreadUrl) } : {}),
          ...(s.topic.latestUrl ? { latestUrl: topicUrl(s.topic.latestUrl) } : {}) } })),
      config: h.config && { ...h.config,
        editable: Object.fromEntries(Object.entries(h.config.editable ?? {}).map(([k, v]) => [configKey(k), v])),
        localOverrides: (h.config.localOverrides ?? []).map(configKey) } }));
    const accounts = (snap.accounts ?? []).map((a) => {
      const parts = a.detail?.split(' · ') ?? [];
      const detail = a.agent === 'claude' && parts.length > 1 ? [org(parts[0], a.label), ...parts.slice(1)].join(' · ') : a.detail;
      return { ...a, key: account(a.key), label: seat(a.label), email: mail(a.email), detail, hosts: (a.hosts ?? []).map(host) };
    });
    const configPending = (snap.configPending ?? []).map((c) => ({ ...c, key: configKey(c.key), host: host(c.host) }));
    return { ...snap, demo: true, configPending,
      hosts: hosts.map((h) => (h.config ? { ...h, config: { ...h.config, facts: { ...h.config.facts, dashboardError: text(h.config.facts?.dashboardError) } } } : h)),
      accounts: accounts.map((a) => ({ ...a, problems: (a.problems ?? []).map(text) })),
      events: (snap.events ?? []).map((e) => ({ ...e,
        ...(e.account ? { account: { ...e.account, label: seat(e.account.label), email: mail(e.account.email) } } : {}),
        ...(e.host ? { host: host(e.host) } : {}), ...(e.key ? { key: configKey(e.key) } : {}),
        ...(e.problem ? { problem: text(e.problem) } : {}), ...(e.error ? { error: text(e.error) } : {}) })) };
  };
  /** The Usage tab's report (scripts/dashboard/usage-store.mjs): its projects and machines, under the same names. */
  mask.usage = (r) => r && { ...r, projects: (r.projects ?? []).map((x) => ({ ...x, k: project(x.k) })),
    machines: (r.machines ?? []).map((x) => ({ ...x, k: host(x.k) })) };
  return mask;
}
