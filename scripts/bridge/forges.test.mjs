import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeSources, readSource, ForgeReader } from './forges.mjs';
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
    { kind: 'gitea', base: 'https://git.example.org/', repos: ['team/a', 'bad'] },
    { kind: 'gitlab', owner: 'x' }, { kind: 'gitea', base: 'http://insecure', owner: 'x' }, null,
  ]), [
    { kind: 'github', base: 'https://github.com', owner: 'someone', repos: [] },
    { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'] },
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
  const repos = await readSource({ kind: 'github', base: 'https://github.com', owner: 'someone', repos: [] }, { token: 't', fetch, now: () => NOW });
  assert.equal(calls.length, 1, 'a repo idle over a year ends paging: the list is ordered by last push');
  assert.deepEqual(calls[0], ['https://api.github.com/graphql', 'Bearer t']);
  assert.deepEqual(repos, [{
    key: 'github.com/someone/live', forge: 'github', name: 'someone/live', url: 'https://github.com/someone/live', private: false,
    defaultBranch: 'main', pushedAt: day(1), at: NOW, error: null,
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
  const [r] = await readSource({ kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'] }, { token: 't', fetch, now: () => NOW });
  assert.equal(r.key, 'git.example.org/team/a');
  assert.deepEqual(r.branches.map((b) => [b.name, b.author, b.ci]), [['main', 'A', 'success'], ['old', 'b', null]]);
  assert.deepEqual(r.pulls, [{ number: 3, title: 'WIP: thing', url: 'https://git.example.org/team/a/pulls/3', draft: true, author: 'b', head: 'old', base: 'main',
    review: null, conflict: false, ci: null, updatedAt: day(2) }]);
});

test('a forge this host cannot reach or has no token for reports nothing; a failing repo reports its error', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'] };
  assert.deepEqual(await readSource(src, { token: null, fetch: async () => { throw new Error('unreachable'); }, now: () => NOW }), []);
  assert.deepEqual(await readSource(src, { token: 't', fetch: async () => { throw new TypeError('fetch failed'); }, now: () => NOW }), [], 'unreachable: not this host\'s to report');
  await assert.rejects(readSource(src, { token: 't', fetch: async () => { throw new RangeError('a bug'); }, now: () => NOW }), /a bug/, 'a fault is said, not hidden');
  const [r] = await readSource(src, { token: 't', fetch: async () => ({ ok: false, status: 500 }), now: () => NOW });
  assert.deepEqual([r.key, r.error], ['git.example.org/team/a', 'HTTP 500']);
});

test('the reader refreshes in the background at most every interval and keeps the last reading', async () => {
  let t = 0, reads = 0;
  const r = new ForgeReader({ sources: [{ kind: 'github', base: 'https://github.com', owner: 'o', repos: [] }], everyMs: 1000, now: () => t,
    token: () => 't', readOne: async () => { reads++; return [{ key: 'github.com/o/r' }]; } });
  assert.deepEqual(r.read(), []);
  await r.pending;
  assert.deepEqual(r.read(), [{ key: 'github.com/o/r' }]);
  t = 500; r.read(); assert.equal(reads, 1);
  t = 1000; r.read(); await r.pending; assert.equal(reads, 2);
  assert.deepEqual(new ForgeReader({}).read(), [], 'nothing configured: nothing read');
});
