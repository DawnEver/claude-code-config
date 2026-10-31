import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeSources, readSource, sourceId, ForgeReader } from './forges.mjs';
import { repoKey } from '../shared/repo-key.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();

test('repo key: one identity for every URL form of a repository', () => {
  for (const u of ['https://GitHub.com/Org/Repo.git', 'git@github.com:org/repo.git', 'ssh://git@github.com:22/org/repo', 'https://github.com/org/repo/'])
    assert.equal(repoKey(u), 'github.com/org/repo');
  assert.equal(repoKey('/local/path'), null);
});

test('forge sources: kind, base and owner or repos; anything else is dropped', () => {
  assert.deepEqual(forgeSources([
    { kind: 'github', owner: 'someone' },
    { kind: 'gitea', base: 'https://git.example.org/', repos: ['team/a', 'bad'], show: ['team/a'], keyUsername: 'dashboard' },
    { kind: 'gitlab', owner: 'x' }, { kind: 'gitea', base: 'http://insecure', owner: 'x' }, null,
  ]), [
    { kind: 'github', base: 'https://github.com', owner: 'someone', repos: [], show: null, keyUsername: null },
    { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: ['team/a'], keyUsername: 'dashboard' },
  ]);
});

const commit = (oid, date, state) => ({ oid, committedDate: date, author: { name: 'A', user: { login: 'a' } }, statusCheckRollup: state ? { state } : null });

test('github: one GraphQL query per page maps repos, branches and open PRs; repos idle over a year end the read', async () => {
  const calls = [];
  const page = { repositoryOwner: { repositories: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [
    { name: 'live', url: 'https://github.com/someone/live', isPrivate: false, isArchived: false, pushedAt: day(1), defaultBranchRef: { name: 'main' },
      refs: { nodes: [{ name: 'main', target: commit('a1', day(1), 'SUCCESS') }, { name: 'feat', target: commit('b2', day(2), 'FAILURE') }] },
      pullRequests: { nodes: [{ number: 7, title: 'Feat', url: 'https://github.com/someone/live/pull/7', isDraft: false, author: { login: 'a' },
        headRefName: 'feat', baseRefName: 'main', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', updatedAt: day(2),
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }] } },
    { name: 'archived', isArchived: true, pushedAt: day(3), refs: { nodes: [] }, pullRequests: { nodes: [] } },
    { name: 'old', isArchived: false, pushedAt: day(400), refs: { nodes: [] }, pullRequests: { nodes: [] } },
  ] } } };
  const fetch = async (url, opts) => { calls.push([url, opts.headers.Authorization]); return { ok: true, json: async () => ({ data: page }) }; };
  const { repos } = await readSource({ kind: 'github', base: 'https://github.com', owner: 'someone', repos: [] }, { token: 't', fetch, now: () => NOW });
  assert.equal(calls.length, 1, 'a repo idle over a year ends paging: the list is ordered by last push');
  assert.deepEqual(calls[0], ['https://api.github.com/graphql', 'Bearer t']);
  assert.deepEqual(repos, [{
    key: 'github.com/someone/live', forge: 'github', name: 'someone/live', url: 'https://github.com/someone/live', private: false,
    defaultBranch: 'main', pushedAt: day(1), at: NOW, error: null, pinned: true,
    branches: [{ name: 'main', sha: 'a1', at: day(1), author: 'a', ci: 'success' }, { name: 'feat', sha: 'b2', at: day(2), author: 'a', ci: 'failure' }],
    pulls: [{ number: 7, title: 'Feat', url: 'https://github.com/someone/live/pull/7', draft: false, author: 'a', head: 'feat', base: 'main',
      review: 'required', conflict: true, ci: 'pending', updatedAt: day(2) }],
  }]);
});

test('gitea: REST per repo — branches newest first, open PRs, each head\'s combined commit status', async () => {
  const api = {
    '/api/v1/repos/team/a': { full_name: 'team/a', html_url: 'https://git.example.org/team/a', private: true, default_branch: 'main', updated_at: day(1) },
    '/api/v1/repos/team/a/branches?limit=50': [
      { name: 'old', commit: { id: 'o1', timestamp: day(9), author: { username: 'b' } } },
      { name: 'main', commit: { id: 'm1', timestamp: day(1), author: { name: 'A' } } }],
    '/api/v1/repos/team/a/pulls?state=open&limit=30': [{ number: 3, title: 'WIP: thing', html_url: 'https://git.example.org/team/a/pulls/3', draft: true,
      user: { login: 'b' }, head: { ref: 'old', sha: 'o1' }, base: { ref: 'main' }, mergeable: true, updated_at: day(2) }],
    '/api/v1/repos/team/a/commits/m1/status': { state: 'success' },
    '/api/v1/repos/team/a/commits/o1/status': { state: '' },
  };
  const fetch = async (url) => { const p = url.replace('https://git.example.org', ''); return p in api ? { ok: true, json: async () => api[p] } : { ok: false, status: 404 }; };
  const { repos: [r] } = await readSource({ kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'] }, { token: 't', fetch, now: () => NOW });
  assert.equal(r.key, 'git.example.org/team/a');
  assert.deepEqual(r.branches.map((b) => [b.name, b.author, b.ci]), [['main', 'A', 'success'], ['old', 'b', null]]);
  assert.deepEqual(r.pulls, [{ number: 3, title: 'WIP: thing', url: 'https://git.example.org/team/a/pulls/3', draft: true, author: 'b', head: 'old', base: 'main',
    review: null, conflict: false, ci: null, updatedAt: day(2) }]);
});

test('one reading per source: repos, the forge refusing, or this host unable to read; a fault throws', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: ['team/b'], keyUsername: 'dashboard' };
  assert.deepEqual(await readSource(src, { token: null, now: () => NOW }), { unavailable: 'no token for git.example.org (dashboard)' });
  assert.deepEqual(await readSource(src, { token: 't', fetch: async () => { throw new TypeError('fetch failed'); }, now: () => NOW, delays: [0, 0] }), { unavailable: 'git.example.org unreachable' });
  await assert.rejects(readSource(src, { token: 't', fetch: async () => { throw new RangeError('a bug'); }, now: () => NOW }), /a bug/, 'a fault is said, not hidden');
  const { repos: [r] } = await readSource(src, { token: 't', fetch: async () => ({ ok: false, status: 401 }), now: () => NOW });
  assert.deepEqual([r.key, r.pinned], ['git.example.org/team/a', false], 'a repo the forge refused is still that repo, with its error');
  assert.match(r.error, /^HTTP 401: the token is refused/);
  assert.equal(sourceId(src), 'gitea|git.example.org||team/a', 'what is read, not how it is shown or keyed');
});

test('the reader reads only what the gateway assigns, once at a time, and keeps each reading until delivered', async () => {
  const src = { kind: 'github', base: 'https://github.com', owner: 'o', repos: [] };
  let reads = 0, release;
  const r = new ForgeReader({ sources: [src], now: () => NOW, token: () => ({ token: 't' }),
    readOne: () => { reads++; return new Promise((ok) => { release = () => ok({ repos: [{ key: 'github.com/o/r' }] }); }); } });
  assert.deepEqual(r.ids(), ['github|github.com|o|']);
  r.assign(['github|github.com|o|', 'unknown']); r.assign(['github|github.com|o|']);
  assert.equal(reads, 1, 'a source being read is not read again');
  release(); await new Promise((ok) => setTimeout(ok, 0));
  const out = r.outbox();
  assert.deepEqual(out, [{ source: 'github|github.com|o|', at: NOW, repos: [{ key: 'github.com/o/r' }] }]);
  r.delivered(out);
  assert.deepEqual(r.outbox(), []);
});

test('a refused credential gets git\'s own round: rejected, filled again (renewed by its helper), retried, then approved', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: null, keyUsername: null };
  const settled = [];
  let fills = 0;
  const token = () => { const t = ++fills === 1 ? 'expired' : 'renewed'; return { token: t, settle: (ok) => settled.push([t, ok]) }; };
  const readOne = async (s, { token: t }) => (t === 'expired' ? { repos: [{ key: 'git.example.org/team/a', error: 'HTTP 401: the token is refused (expired or revoked)' }] }
    : { repos: [{ key: 'git.example.org/team/a', error: null }] });
  const r = new ForgeReader({ sources: [src], now: () => NOW, token, readOne });
  r.assign(r.ids());
  await new Promise((ok) => setTimeout(ok, 0));
  assert.deepEqual(settled, [['expired', false], ['renewed', true]]);
  assert.equal(r.outbox()[0].repos[0].error, null);
});

test('a network blip or a 5xx is tried twice more before it counts; a definite answer is not retried', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: null, keyUsername: null };
  const ok = { '/api/v1/repos/team/a': { full_name: 'team/a', html_url: 'https://git.example.org/team/a', default_branch: 'main', updated_at: day(1) },
    '/api/v1/repos/team/a/branches?limit=50': [], '/api/v1/repos/team/a/pulls?state=open&limit=30': [] };
  let calls = 0;
  const flaky = (failures, fail) => async (url) => (++calls <= failures ? fail() : { ok: true, json: async () => ok[url.replace('https://git.example.org', '')] });
  const read = (fetch) => readSource(src, { token: 't', fetch, now: () => NOW, delays: [0, 0] });
  const { repos: [r] } = await read(flaky(2, () => { throw new TypeError('fetch failed'); }));
  assert.equal(r.error, null, 'two blips, then read');
  calls = 0;
  const { repos: [s] } = await read(flaky(2, () => ({ ok: false, status: 502 })));
  assert.equal(s.error, null, 'two 502s, then read');
  calls = 0;
  assert.deepEqual(await read(flaky(3, () => { throw new TypeError('fetch failed'); })), { unavailable: 'git.example.org unreachable' }, 'three in a row: unreachable');
  calls = 0;
  const { repos: [u] } = await read(async () => { calls++; return { ok: false, status: 404 }; });
  assert.deepEqual([u.error, calls], ['HTTP 404', 1], 'a 404 is an answer, asked once');
});
