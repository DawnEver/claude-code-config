import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeSources, forgeToken, readSource, sourceId, ForgeReader, readHistory } from './forges.mjs';
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

test('a refused credential is reported and left in the store: no reject that would drop the user git login', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: null, keyUsername: null };
  let fills = 0;
  const r = new ForgeReader({ sources: [src], now: () => NOW, token: () => { fills++; return { token: 'expired' }; },
    readOne: async () => ({ repos: [{ key: 'git.example.org/team/a', error: 'HTTP 401: the token is refused (expired or revoked)' }] }) });
  r.assign(r.ids());
  await new Promise((ok) => setTimeout(ok, 0));
  assert.equal(fills, 1, 'read once, no second fill');
  assert.match(r.outbox()[0].repos[0].error, /^HTTP 401/);
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

test('a refused credential is reported and the credential store is only read, never written or rejected', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: null, keyUsername: null };
  const gitCalls = [];
  const run = (cmd, args) => { gitCalls.push(args[1]); return cmd === 'git' && args[1] === 'fill' ? { status: 0, stdout: 'username=u\npassword=expired\n' } : { status: 1 }; };
  const readOne = async () => ({ repos: [{ key: 'git.example.org/team/a', error: 'HTTP 401: the token is refused (expired or revoked)' }] });
  const r = new ForgeReader({ sources: [src], now: () => NOW, token: (s) => forgeToken(s, { run }), readOne });
  r.assign(r.ids());
  await new Promise((ok) => setTimeout(ok, 0));
  assert.match(r.outbox()[0].repos[0].error, /^HTTP 401/);
  assert.deepEqual(gitCalls, ['fill'], 'only `git credential fill`: no reject, approve or ls-remote');
});

test('history: read after a good reading, a year back the first time, then from the stored cursor; an unfinished window is continued, not dropped', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const cursorFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-')), 'cursor.json');
  const src = { kind: 'gitea', base: 'https://git.example.org', owner: null, repos: ['team/a'], show: null, keyUsername: null };
  const asked = [];
  let t = NOW;
  const r = new ForgeReader({ sources: [src], now: () => t, token: () => ({ token: 't' }), cursorFile,
    readOne: async () => ({ repos: [{ key: 'git.example.org/team/a', name: 'team/a', defaultBranch: 'main', pushedAt: new Date(t).toISOString(), error: null }] }),
    readHistory: async (s, { windows }) => {
      asked.push(windows);
      // The first read stops at a page cap: its window comes back unfinished.
      return { commits: [{ repo: 'git.example.org/team/a', sha: 'a1b2c3d', at: NOW }], pulls: [],
        rest: asked.length === 1 ? [{ ...windows[0], commits: 21, pulls: false }] : [] };
    } });
  const settle = () => new Promise((ok) => setTimeout(ok, 0));
  r.assign(r.ids()); await settle(); await settle();
  assert.deepEqual(asked[0], [{ name: 'team/a', key: 'git.example.org/team/a', branch: 'main', since: NOW - 366 * 86400000, until: NOW }], 'a year back the first time');
  const h = r.takeHistory();
  assert.deepEqual([h.commits.length, h.pulls.length], [1, 0]);
  r.assign(r.ids()); await settle(); await settle();
  assert.equal(asked.length, 1, 'not read again while the last is unsent');
  h.stored();
  assert.equal(r.takeHistory(), null);
  t = NOW + 600000;
  r.assign(r.ids()); await settle(); await settle();
  assert.deepEqual(asked[1], [
    { name: 'team/a', key: 'git.example.org/team/a', branch: 'main', since: NOW - 366 * 86400000, until: NOW, commits: 21, pulls: false },
    { name: 'team/a', key: 'git.example.org/team/a', branch: 'main', since: NOW - 3600000, until: NOW + 600000 },
  ], 'the unfinished window continued where it stopped, and a new one from the cursor with an hour of overlap');
  r.takeHistory().stored();
  t = NOW + 1200000;
  r.assign(r.ids()); await settle(); await settle();
  assert.equal(asked[2].length, 1, 'a finished window is not asked again');
});

test('readHistory gitea: a window over the page cap returns where it stopped, and the next read continues one page back', async () => {
  const src = { kind: 'gitea', base: 'https://git.example.org' };
  const w = { name: 'team/a', key: 'git.example.org/team/a', branch: 'main', since: NOW - 86400000, until: NOW };
  const urls = [];
  const full = (n) => Array.from({ length: 50 }, (_, i) => ({ sha: `${n}-${i}`, number: n * 100 + i, created_at: day(1), commit: { committer: { date: day(1) } } }));
  const fetch = async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => (u.includes('/commits') ? full(Number(/page=(\d+)/.exec(u)[1])) : []) }; };
  const one = await readHistory(src, { token: 't', windows: [w], fetch, delays: [] });
  assert.equal(one.commits.length, 20 * 50);
  assert.deepEqual(one.rest, [{ ...w, commits: 21, pulls: false }]);
  assert.ok(urls.some((u) => u.includes('/issues?type=pulls') && u.includes('before=')), 'pull requests read within the window');
  urls.length = 0;
  await readHistory(src, { token: 't', windows: one.rest, fetch, delays: [] });
  assert.match(urls[0], /page=20&/, 'one page back from where it stopped');
  assert.ok(!urls.some((u) => u.includes('/issues')), 'a finished kind is not asked again');
});

test('readHistory github: commits continue from the cursor; pull requests past the 1000 search cap continue below the oldest update read', async () => {
  const src = { kind: 'github', base: 'https://github.com' };
  const w = { name: 'o/a', key: 'github.com/o/a', branch: 'main', since: NOW - 86400000, until: NOW };
  const asked = [];
  const fetch = async (u, init) => {
    const { query, variables } = JSON.parse(init.body);
    asked.push(variables);
    if (query.includes('history(')) return { ok: true, status: 200, json: async () => ({ data: { repository: { defaultBranchRef: { target: { history: {
      pageInfo: { hasNextPage: true, endCursor: `c${asked.length}` }, nodes: [{ oid: `s${asked.length}`, committedDate: day(1), author: { name: 'x' } }] } } } } } }) };
    const n = asked.filter((v) => v.q).length;
    return { ok: true, status: 200, json: async () => ({ data: { search: { pageInfo: { hasNextPage: n % 10 !== 0, endCursor: `p${n}` },
      nodes: Array.from({ length: 100 }, (_, i) => ({ number: n * 100 + i, createdAt: day(2), updatedAt: new Date(NOW - n * 60000 - i * 1000).toISOString(), author: { login: 'x' } })) } } }) };
  };
  const one = await readHistory(src, { token: 't', windows: [w], fetch, delays: [] });
  assert.equal(one.rest[0].commits, 'c10', 'commits: the cursor after the last page read');
  assert.equal(one.rest[0].pulls, new Date(NOW - 10 * 60000 - 99000).toISOString().replace(/\.\d+Z$/, 'Z'), 'pulls: the oldest update read');
  asked.length = 0;
  await readHistory(src, { token: 't', windows: one.rest, fetch, delays: [] });
  assert.equal(asked[0].after, 'c10');
  assert.ok(asked.find((v) => v.q).q.includes(`..${one.rest[0].pulls} `), 'the search asks only below it');
});
