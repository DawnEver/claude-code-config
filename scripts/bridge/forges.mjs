// scripts/bridge/forges.mjs — what this host can see of its code forges, for the dashboard's
// Code tab (docs/dashboard.md "Code").
//
// A forge is reached by whichever host can reach it: a forge inside a private network is read
// by the hosts on that network, a public one by any. So the hosts read, and the gateway merges by
// repository (scripts/shared/repo-key.mjs), as it does accounts. Sources are configuration —
// `bridge.forges: [{kind, base?, owner? | repos?}]` in the shared settings — and the token is
// this host's own: `gh auth token` for GitHub, else the git credential store for the forge host.
// Each kind is one adapter mapping its API onto one model:
//   Repo {key, forge, name, url, private, defaultBranch, pushedAt, at, error, branches, pulls}
//   Branch {name, sha, at, author, ci}   Pull {number, title, url, draft, author, head, base, review, conflict, ci, updatedAt}
// `ci` is the head commit's combined check state: 'success' | 'failure' | 'pending' | null (none).

import { spawnSync } from 'child_process';
import { fetchKey } from '../shared/credential-key.mjs';
import { repoKey } from '../shared/repo-key.mjs';

const TIMEOUT_MS = 20000;
const HORIZON_MS = 366 * 86400000;   // the Code tab's longest range: older activity is never read
const MAX_BRANCHES = 20, MAX_PULLS = 30;
const KINDS = { github: 'https://github.com', gitea: null };

/** The configured sources, valid ones only: an https base, and an owner (all its repos) or `owner/name` repos. */
export function forgeSources(raw) {
  return (Array.isArray(raw) ? raw : []).flatMap((s) => {
    if (!s || !(s.kind in KINDS)) return [];
    const base = String(s.base ?? KINDS[s.kind] ?? '').replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/]+$/.test(base)) return [];
    const owner = typeof s.owner === 'string' && /^[\w.-]+$/.test(s.owner) ? s.owner : null;
    const names = (v) => (Array.isArray(v) ? v : []).filter((r) => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r));
    const repos = names(s.repos);
    // `show`: the repos the Code tab shows by default (a device may choose others); absent = all.
    const show = Array.isArray(s.show) ? names(s.show) : null;
    // `keyUsername`: which credential of the forge host is the token (a stored API token), else the host's only one.
    const keyUsername = typeof s.keyUsername === 'string' && /^[\w.@-]{1,64}$/.test(s.keyUsername) ? s.keyUsername : null;
    return owner || repos.length ? [{ kind: s.kind, base, owner, repos, show, keyUsername }] : [];
  });
}

const CI = { SUCCESS: 'success', success: 'success', FAILURE: 'failure', ERROR: 'failure', failure: 'failure', error: 'failure',
  PENDING: 'pending', EXPECTED: 'pending', pending: 'pending', warning: 'success' };
const ciState = (s) => CI[s] ?? null;
const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' };

/** A network failure or timeout (Node's fetch: TypeError 'fetch failed'; AbortSignal.timeout: TimeoutError). */
const unreachable = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError' || (e instanceof TypeError && e.message === 'fetch failed');

/** A request that throws on a network failure (this host cannot reach the forge) and on an HTTP error. */
/** Waits before each retry of a transient failure: two retries, so three attempts in all. */
export const RETRY_DELAYS_MS = [1000, 3000];
const transient = (status) => status === 429 || status >= 500;

async function getJson(fetch, url, token, init = {}, delays = init.delays ?? RETRY_DELAYS_MS) {
  let res;
  // A network blip, a timeout or a 5xx/429 is tried again; a definite answer (401, 404) is not.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { ...init, headers: { Accept: 'application/json', Authorization: `${init.scheme ?? 'Bearer'} ${token}`, ...init.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!transient(res.status) || attempt >= delays.length) break;
    } catch (e) {
      if (!unreachable(e) || attempt >= delays.length) throw e;
    }
    await new Promise((ok) => setTimeout(ok, delays[attempt]));
  }
  if (!res.ok) {
    const e = new Error(res.status === 401 ? 'HTTP 401: the token is refused (expired or revoked)' : `HTTP ${res.status}`);
    e.http = true;
    throw e;
  }
  return res.json();
}

const GITHUB_QUERY = `query($login: String!, $after: String) { repositoryOwner(login: $login) { repositories(first: 50, after: $after, orderBy: {field: PUSHED_AT, direction: DESC}) {
  pageInfo { hasNextPage endCursor }
  nodes { name url isPrivate isArchived pushedAt
    defaultBranchRef { name target { ... on Commit { oid committedDate author { name user { login } } statusCheckRollup { state } } } }
    refs(refPrefix: "refs/heads/", first: ${MAX_BRANCHES}, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name
      target { ... on Commit { oid committedDate author { name user { login } } statusCheckRollup { state } } } } }
    pullRequests(states: OPEN, first: ${MAX_PULLS}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url isDraft author { login }
      headRefName baseRefName reviewDecision mergeable updatedAt commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } } } }`;

const ADAPTERS = {
  /** GitHub: one GraphQL page of up to 50 repos, newest push first, until a repo idle past the horizon. */
  async github(src, { token, fetch, now, delays }) {
    const out = [];
    for (const owner of src.owner ? [src.owner] : [...new Set(src.repos.map((full) => full.split('/')[0]))]) {
      for (let after = null; ;) {
        const body = await getJson(fetch, 'https://api.github.com/graphql', token,
          { method: 'POST', delays, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: GITHUB_QUERY, variables: { login: owner, after } }) });
        if (body.errors?.length) throw Object.assign(new Error(body.errors[0].message), { http: true });
        const page = body.data?.repositoryOwner?.repositories;
        if (!page) break;
        let past = false;
        for (const r of page.nodes) {
          if (Date.parse(r.pushedAt) < now() - HORIZON_MS) { past = true; break; }
          if (!r.isArchived) out.push(githubRepo(r, now()));
        }
        if (past || !page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
    }
    // Listed repos narrow an owner's set; on their own they name their owners.
    return src.repos.length ? out.filter((r) => src.repos.some((full) => full.toLowerCase() === r.name.toLowerCase())) : out;
  },

  /** Gitea (and Forgejo): REST per repo; each branch and PR head's combined commit status. */
  async gitea(src, { token, fetch, now, delays }) {
    const api = `${src.base}/api/v1`;
    const get = (p) => getJson(fetch, `${api}${p}`, token, { scheme: 'token', delays });
    let names = [...src.repos];
    if (src.owner) {
      const list = await get(`/orgs/${src.owner}/repos?limit=50`).catch((e) => (e.http ? get(`/users/${src.owner}/repos?limit=50`) : Promise.reject(e)));
      names = [...new Set([...names, ...list.filter((r) => !r.archived && Date.parse(r.updated_at) >= now() - HORIZON_MS).map((r) => r.full_name)])];
    }
    const out = [];
    for (const full of names) {
      try {
        const r = await get(`/repos/${full}`);
        // The newest branches, and the default branch however old: its CI is the repo's headline.
        const branches = (await get(`/repos/${full}/branches?limit=50`))
          .sort((a, b) => Date.parse(b.commit?.timestamp) - Date.parse(a.commit?.timestamp))
          .filter((b, i) => i < MAX_BRANCHES || b.name === r.default_branch);
        const pulls = (await get(`/repos/${full}/pulls?state=open&limit=${MAX_PULLS}`)).slice(0, MAX_PULLS);
        const status = new Map();
        for (const sha of new Set([...branches.map((b) => b.commit?.id), ...pulls.map((p) => p.head?.sha)].filter(Boolean))) {
          status.set(sha, ciState((await get(`/repos/${full}/commits/${sha}/status`).catch(() => ({}))).state));
        }
        out.push({ key: repoKey(r.html_url), forge: 'gitea', name: r.full_name, url: r.html_url, private: Boolean(r.private),
          defaultBranch: r.default_branch, pushedAt: r.updated_at, at: now(), error: null,
          branches: branches.map((b) => ({ name: b.name, sha: b.commit?.id ?? null, at: b.commit?.timestamp ?? null,
            author: b.commit?.author?.username ?? b.commit?.author?.name ?? null, ci: status.get(b.commit?.id) ?? null })),
          pulls: pulls.map((p) => ({ number: p.number, title: p.title, url: p.html_url, draft: Boolean(p.draft ?? /^(WIP|Draft):/i.test(p.title)),
            author: p.user?.login ?? null, head: p.head?.ref ?? null, base: p.base?.ref ?? null, review: null,
            conflict: p.mergeable === false, ci: status.get(p.head?.sha) ?? null, updatedAt: p.updated_at })) });
      } catch (e) {
        if (!e.http) throw e;   // unreachable or a fault: the source decides
        out.push({ key: repoKey(`${src.base}/${full}`), forge: 'gitea', name: full, url: `${src.base}/${full}`, private: null,
          defaultBranch: null, pushedAt: null, at: now(), error: e.message, branches: [], pulls: [] });
      }
    }
    return out;
  },
};

function githubRepo(r, at) {
  const ci = (c) => ciState(c?.statusCheckRollup?.state);
  return { key: repoKey(r.url), forge: 'github', name: new URL(r.url).pathname.slice(1), url: r.url, private: r.isPrivate,
    defaultBranch: r.defaultBranchRef?.name ?? null, pushedAt: r.pushedAt, at, error: null,
    // The newest branches, and the default branch however old: its CI is the repo's headline.
    branches: [...r.refs.nodes, ...(r.defaultBranchRef && !r.refs.nodes.some((b) => b.name === r.defaultBranchRef.name) ? [r.defaultBranchRef] : [])].map((b) => ({ name: b.name, sha: b.target?.oid ?? null, at: b.target?.committedDate ?? null,
      author: b.target?.author?.user?.login ?? b.target?.author?.name ?? null, ci: ci(b.target) })).sort((x, y) => String(y.at).localeCompare(String(x.at))),
    pulls: r.pullRequests.nodes.map((p) => ({ number: p.number, title: p.title, url: p.url, draft: p.isDraft, author: p.author?.login ?? null,
      head: p.headRefName, base: p.baseRefName, review: REVIEW[p.reviewDecision] ?? null, conflict: p.mergeable === 'CONFLICTING',
      ci: ci(p.commits?.nodes?.[0]?.commit), updatedAt: p.updatedAt })) };
}

/**
 * A source's identity, the same on every host that reads the same shared settings: what is read
 * (kind, forge host, owner, repos), not how it is shown or which credential reads it.
 */
// `|`-separated: a forge host may carry a port (`git.example.org:8443`).
export const sourceId = (src) => `${src.kind}|${new URL(src.base).host}|${src.owner ?? ''}|${[...src.repos].sort().join(',')}`;

/**
 * One source as this host sees it, as one reading: `{repos}`, or `{error}` when the forge refused
 * (a refused token, an HTTP error), or `{unavailable}` when this host cannot read it at all (no
 * token, the forge unreachable) — then the gateway asks another host. A fault in this code throws.
 */
export async function readSource(src, { token, fetch = globalThis.fetch, now = Date.now, delays = RETRY_DELAYS_MS }) {
  if (!token) return { unavailable: `no token for ${new URL(src.base).host}${src.keyUsername ? ` (${src.keyUsername})` : ''}` };
  try {
    const repos = await ADAPTERS[src.kind](src, { token, fetch, now, delays });
    return { repos: repos.map((r) => ({ ...r, pinned: !src.show || src.show.some((n) => n.toLowerCase() === r.name.toLowerCase()) })) };
  } catch (e) {
    if (unreachable(e)) return { unavailable: `${new URL(src.base).host} unreachable` };
    if (!e.http) throw e;
    return { error: e.message };
  }
}

/**
 * This host's credential for a forge: GitHub's `gh` login, else the git credential store for the
 * forge host (`keyUsername` picks one when it holds several). For unattended reading store a
 * long-lived read-only API token there; an OAuth login a git helper renews only with a browser
 * expires within hours. Null when none.
 */
export function forgeToken(src, { run = spawnSync } = {}) {
  if (src.kind === 'github') {
    const gh = run('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
    if (gh.status === 0 && gh.stdout?.trim()) return { token: gh.stdout.trim() };
  }
  const got = fetchKey({ host: new URL(src.base).host, username: src.keyUsername, run });
  return got.key ? { token: got.key } : null;
}

/**
 * The host's side of the gateway's lease (registry.mjs forge leases): the push declares which
 * sources this host is configured for (`ids`); the gateway answers which to read now, at most one
 * host per source per interval; `assign` reads those in the background and keeps each reading in
 * an outbox until a push carrying it is accepted (`delivered`). Reading the same source twice is
 * harmless: the gateway keeps one reading per source, replaced whole.
 */
export class ForgeReader {
  constructor({ sources = [], log = () => {}, now = Date.now, token = forgeToken, readOne = readSource }) {
    Object.assign(this, { sources, log, now, token, readOne });
    this.byId = new Map(sources.map((s) => [sourceId(s), s]));
    this.running = new Set();
    this.out = new Map();   // source id -> reading not yet delivered
  }

  ids() { return [...this.byId.keys()]; }

  assign(ids) {
    for (const id of ids) {
      const src = this.byId.get(id);
      if (!src || this.running.has(id)) continue;
      this.running.add(id);
      this.#read(src)
        .catch((e) => ({ error: `fault: ${String(e.message ?? e).slice(0, 160)}` }))
        .then((r) => {
          this.out.set(id, { source: id, at: this.now(), ...r });
          this.log(`forges: ${id} -> ${r.repos ? `${r.repos.length} repos` : r.error ? `error: ${r.error}` : `unavailable: ${r.unavailable}`}`);
        })
        .finally(() => this.running.delete(id));
    }
  }

  /**
   * One read with this host's credential. A refused one is reported, never rejected from the
   * store: a helper that cannot renew without a browser (Git Credential Manager's OAuth login on
   * some forges) would lose the user's git login for it.
   */
  async #read(src) {
    return this.readOne(src, { token: this.token(src)?.token, now: this.now });
  }

  /** The readings to send with the next push. */
  outbox() { return [...this.out.values()]; }

  /** A push carrying these was accepted: they need not be sent again (a newer reading of the same source stays). */
  delivered(readings) { for (const r of readings) if (this.out.get(r.source) === r) this.out.delete(r.source); }
}
