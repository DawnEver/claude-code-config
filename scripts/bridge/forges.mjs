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
    const repos = (Array.isArray(s.repos) ? s.repos : []).filter((r) => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r));
    return owner || repos.length ? [{ kind: s.kind, base, owner, repos }] : [];
  });
}

const CI = { SUCCESS: 'success', success: 'success', FAILURE: 'failure', ERROR: 'failure', failure: 'failure', error: 'failure',
  PENDING: 'pending', EXPECTED: 'pending', pending: 'pending', warning: 'success' };
const ciState = (s) => CI[s] ?? null;
const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' };

/** A request that throws on a network failure (this host cannot reach the forge) and on an HTTP error. */
async function getJson(fetch, url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { Accept: 'application/json', Authorization: `${init.scheme ?? 'Bearer'} ${token}`, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.http = true; throw e; }
  return res.json();
}

const GITHUB_QUERY = `query($login: String!, $after: String) { repositoryOwner(login: $login) { repositories(first: 50, after: $after, orderBy: {field: PUSHED_AT, direction: DESC}) {
  pageInfo { hasNextPage endCursor }
  nodes { name url isPrivate isArchived pushedAt defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: ${MAX_BRANCHES}, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name
      target { ... on Commit { oid committedDate author { name user { login } } statusCheckRollup { state } } } } }
    pullRequests(states: OPEN, first: ${MAX_PULLS}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url isDraft author { login }
      headRefName baseRefName reviewDecision mergeable updatedAt commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } } } }`;

const ADAPTERS = {
  /** GitHub: one GraphQL page of up to 50 repos, newest push first, until a repo idle past the horizon. */
  async github(src, { token, fetch, now }) {
    const out = [];
    for (const owner of src.owner ? [src.owner] : [...new Set(src.repos.map((full) => full.split('/')[0]))]) {
      for (let after = null; ;) {
        const body = await getJson(fetch, 'https://api.github.com/graphql', token,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: GITHUB_QUERY, variables: { login: owner, after } }) });
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
  async gitea(src, { token, fetch, now }) {
    const api = `${src.base}/api/v1`;
    const get = (p) => getJson(fetch, `${api}${p}`, token, { scheme: 'token' });
    let names = [...src.repos];
    if (src.owner) {
      const list = await get(`/orgs/${src.owner}/repos?limit=50`).catch((e) => (e.http ? get(`/users/${src.owner}/repos?limit=50`) : Promise.reject(e)));
      names = [...new Set([...names, ...list.filter((r) => !r.archived && Date.parse(r.updated_at) >= now() - HORIZON_MS).map((r) => r.full_name)])];
    }
    const out = [];
    for (const full of names) {
      try {
        const r = await get(`/repos/${full}`);
        const branches = (await get(`/repos/${full}/branches?limit=50`))
          .sort((a, b) => Date.parse(b.commit?.timestamp) - Date.parse(a.commit?.timestamp)).slice(0, MAX_BRANCHES);
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
        if (!e.http) throw e;
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
    branches: r.refs.nodes.map((b) => ({ name: b.name, sha: b.target?.oid ?? null, at: b.target?.committedDate ?? null,
      author: b.target?.author?.user?.login ?? b.target?.author?.name ?? null, ci: ci(b.target) })),
    pulls: r.pullRequests.nodes.map((p) => ({ number: p.number, title: p.title, url: p.url, draft: p.isDraft, author: p.author?.login ?? null,
      head: p.headRefName, base: p.baseRefName, review: REVIEW[p.reviewDecision] ?? null, conflict: p.mergeable === 'CONFLICTING',
      ci: ci(p.commits?.nodes?.[0]?.commit), updatedAt: p.updatedAt })) };
}

/**
 * One source as this host sees it: [] when it holds no token or cannot reach the forge (the
 * repos are not this host's to report); a repo whose request fails says so in its `error`.
 */
export async function readSource(src, { token, fetch = globalThis.fetch, now = Date.now }) {
  if (!token) return [];
  try { return await ADAPTERS[src.kind](src, { token, fetch, now }); }
  catch (e) {
    if (!e.http) return [];
    return src.repos.map((full) => ({ key: repoKey(`${src.base}/${full}`), forge: src.kind, name: full, url: `${src.base}/${full}`, private: null,
      defaultBranch: null, pushedAt: null, at: now(), error: e.message, branches: [], pulls: [] }));
  }
}

/** This host's token for a forge: GitHub's `gh` login first, else the git credential store; null when none. */
export function forgeToken(src, { run = spawnSync } = {}) {
  if (src.kind === 'github') {
    const gh = run('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
    if (gh.status === 0 && gh.stdout?.trim()) return gh.stdout.trim();
  }
  const got = fetchKey({ host: new URL(src.base).host, run });
  return got.key ?? null;
}

/** Reads every source at most every `everyMs`, in the background: `read()` is synchronous and returns the last reading. */
export class ForgeReader {
  constructor({ sources = [], everyMs = 5 * 60000, log = () => {}, now = Date.now, token = forgeToken, readOne = readSource }) {
    Object.assign(this, { sources, everyMs, log, now, token, readOne });
    this.last = [];
    this.version = 0;   // one per completed reading: the push sends a reading once
    this.at = -Infinity;
    this.pending = null;
  }

  read() {
    if (this.sources.length && !this.pending && this.now() - this.at >= this.everyMs) {
      this.pending = this.refresh().catch((e) => this.log(`forges: ${e.message}`))
        .finally(() => { this.at = this.now(); this.pending = null; });
    }
    return this.last;
  }

  /** For the dashboard push: the last reading and its version, or null before the first. */
  reading() {
    this.read();
    return this.version ? { version: this.version, list: this.last } : null;
  }

  async refresh() {
    const got = await Promise.all(this.sources.map((s) => this.readOne(s, { token: this.token(s), now: this.now })));
    this.last = got.flat();
    this.version++;
  }
}
