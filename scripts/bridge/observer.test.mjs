import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Observer, provenanceOf } from './observer.mjs';

/**
 * A fake world: one repo at /r with remote tips, commits (sha -> committer), statuses and
 * issues the test edits between polls.
 */
function world({ machine = 'G-Laptop', coordinator = 'G-Laptop', family = true } = {}) {
  const w = {
    tips: { main: 'a0' },
    commits: {},          // range "old..new" or "new" -> [{sha, committer}]
    statuses: {},         // sha -> [{context, state}]
    issues: [],
    comments: [], sinceAsked: [], clock: '2026-10-01T10:00:00.000Z',
    locked: false,
    branchOf: { '/r/sub': 'feat/x' },
    sessions: [],
    posts: [], lanes: [], fetches: 0,
  };
  const git = async (cwd, args) => {
    const cmd = args.join(' ');
    if (cmd === 'rev-parse --show-toplevel') return '/r';
    if (cmd === 'rev-parse --git-dir') return '.git';
    if (cmd === 'rev-parse --abbrev-ref HEAD') return w.branchOf[cwd] ?? 'dev';
    if (args[0] === 'fetch') { w.fetches++; return ''; }
    if (args[0] === 'for-each-ref') return Object.entries(w.tips).map(([b, s]) => `refs/remotes/origin/${b} ${s}`).join('\n');
    if (args[0] === 'log') {
      const range = args.filter((a) => !a.startsWith('--format')).slice(1).join(' ');
      return (w.commits[range] ?? []).map((c) => `${c.sha}\t${c.committer}`).join('\n');
    }
    throw new Error(`unexpected git ${cmd}`);
  };
  const forge = async (top, args) => {
    if (!family) return null;
    if (args[0] === 'status') return w.statuses[args[2]] ?? [];
    if (args[0] === 'issue' && args[1] === 'comments-since') { w.sinceAsked.push(args[2]); return w.comments; }
    if (args[0] === 'issue') return w.issues;
    return null;
  };
  const obs = new Observer({
    machine, config: { coordinator }, git, forge, cacheFile: null, now: () => w.clock,
    exists: (p) => w.locked && p.endsWith('index.lock'),
    sessions: () => w.sessions,
    post: (key, text) => w.posts.push([key, text]),
    postLanes: (chatId, project, text) => w.lanes.push([chatId, project, text]),
  });
  return { w, obs };
}

const lanesSession = { key: 'codex:main', cwd: '/r', chatId: -100, project: 'p' };
const subSession = { key: 'claude:s', cwd: '/r/sub', chatId: -100, project: 'p' };

test('provenanceOf reads `Name (<machine>/<agent>)` from a committer name', () => {
  assert.deepEqual(provenanceOf('Mingyang Bao (WS1/codex)'), { machine: 'WS1', agent: 'codex' });
  assert.equal(provenanceOf('Mingyang Bao'), null);
});

test('the first poll of a repo only seeds; later moves are reported once, where they belong', async () => {
  const { w, obs } = world();
  w.sessions = [lanesSession, subSession];
  await obs.poll();
  assert.deepEqual([w.posts, w.lanes], [[], []], 'nothing historic is reported');

  w.tips['feat/x'] = 'b2';
  w.commits['b2 --not a0'] = [{ sha: 'b2', committer: 'M (G-Laptop/claude)' }, { sha: 'b1', committer: 'M (G-Laptop/claude)' }];
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M' }];
  await obs.poll();
  await obs.poll();
  assert.deepEqual(w.posts, [['claude:s', 'pushed b2 → feat/x (+2)']], 'own push -> the session on that branch');
  assert.deepEqual(w.lanes, [[-100, 'p', 'pushed a1 → main (+1)']], 'unprovenanced -> lanes, coordinator only');
});

test("another machine's push is never reported here; unprovenanced pushes only by the coordinator", async () => {
  const other = world({ machine: 'WS1', coordinator: 'G-Laptop' });
  other.w.sessions = [lanesSession];
  await other.obs.poll();
  other.w.tips.main = 'a1';
  other.w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M' }];
  other.w.tips['feat/y'] = 'c1';
  other.w.commits['c1 --not a1'] = [{ sha: 'c1', committer: 'M (G-Laptop/codex)' }];
  await other.obs.poll();
  assert.deepEqual([other.w.posts, other.w.lanes], [[], []]);
});

test('own push with no session on its branch goes to lanes only on the coordinator', async () => {
  const { w, obs } = world({ machine: 'WS1', coordinator: 'G-Laptop' });
  w.sessions = [lanesSession];
  await obs.poll();
  w.tips['feat/z'] = 'd1';
  w.commits['d1 --not a0'] = [{ sha: 'd1', committer: 'M (WS1/codex)' }];
  await obs.poll();
  assert.deepEqual([w.posts, w.lanes], [[], []], 'non-coordinators post only into their own session Topics');
});

test('lab/gate and lab/heavy verdicts on a reported tip follow it, once each', async () => {
  const { w, obs } = world();
  w.sessions = [lanesSession, subSession];
  await obs.poll();
  w.tips['feat/x'] = 'b2';
  w.commits['b2 --not a0'] = [{ sha: 'b2', committer: 'M (G-Laptop/claude)' }];
  await obs.poll();
  w.statuses.b2 = [{ context: 'lab/gate', state: 'success' }, { context: 'lab/test', state: 'success' }];
  await obs.poll();
  w.statuses.b2 = [{ context: 'lab/gate', state: 'success' }, { context: 'lab/heavy', state: 'failure' }, { context: 'lab/test', state: 'success' }];
  await obs.poll();
  await obs.poll();
  assert.deepEqual(w.posts.map(([, t]) => t), ['pushed b2 → feat/x (+1)', 'lab/gate PASS b2', 'lab/heavy FAIL b2']);
});

test('issues: seeded first, then new ones and @machine hints go to lanes (coordinator only)', async () => {
  const { w, obs } = world();
  w.sessions = [lanesSession];
  w.issues = [{ number: 1, title: 'old', body: '' }];
  await obs.poll();
  w.issues = [...w.issues, { number: 2, title: 'flaky gate', body: 'seen on main' }, { number: 3, title: 'port solver', body: 'for @WS2 and @G-Laptop' }];
  await obs.poll();
  await obs.poll();
  assert.deepEqual(w.lanes.map(([, , t]) => t), ['issue #2: flaky gate', 'issue #3: port solver', 'hint: @WS2 #3 port solver', 'hint: @G-Laptop #3 port solver']);
  const nonCoord = world({ machine: 'WS1' });
  nonCoord.w.sessions = [lanesSession];
  await nonCoord.obs.poll();
  nonCoord.w.issues = [{ number: 9, title: 'x', body: '@WS1' }];
  await nonCoord.obs.poll();
  assert.deepEqual(nonCoord.w.lanes, []);
});

test('a held index.lock skips the repo; a non-family repo still gets the git part', async () => {
  const { w, obs } = world({ family: false });
  w.sessions = [lanesSession];
  w.locked = true;
  await obs.poll();
  assert.equal(w.fetches, 0);
  w.locked = false;
  await obs.poll();
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M' }];
  w.issues = [{ number: 5, title: 'never read', body: '' }];
  await obs.poll();
  assert.deepEqual(w.lanes.map(([, , t]) => t), ['pushed a1 → main (+1)']);
});

test('a push to the branch a session is on goes to that session, whoever pushed it (coordinator)', async () => {
  const { w, obs } = world();
  w.sessions = [{ ...lanesSession }];
  w.branchOf['/r'] = 'main';
  await obs.poll();
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M' }];
  await obs.poll();
  assert.deepEqual([w.posts, w.lanes], [[['codex:main', 'pushed a1 → main (+1)']], []]);
});

test('comment @machine hints: since the last poll, once per comment id, self-mentions skipped', async () => {
  const { w, obs } = world();
  w.sessions = [lanesSession];
  w.issues = [{ number: 3, title: 'port solver', body: '' }];
  w.comments = [{ issue: 3, id: 1, author: 'bot', body: 'old @WS2', created: 'x' }];
  await obs.poll();   // seeds: nothing historic
  assert.deepEqual(w.sinceAsked, []);
  w.clock = '2026-10-01T10:05:00.000Z';
  w.comments = [
    { issue: 3, id: 2, author: 'bot', body: 'can @WS2 take this?\nsecond line', created: 'x' },
    { issue: 3, id: 3, author: 'bot', body: '[WS1 · codex · feat/x]\n\nhanding back, @WS1 and @G-Laptop', created: 'x' },
    { issue: 8, id: 4, author: 'bot', body: 'hey @WS1', created: 'x' },
  ];
  await obs.poll();
  await obs.poll();   // same ids again: posted once
  assert.deepEqual(w.sinceAsked, ['2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z']);
  assert.deepEqual(w.lanes.map(([, , t]) => t), [
    'hint: @WS2 #3 port solver — can @WS2 take this?',
    'hint: @G-Laptop #3 port solver — handing back, @WS1 and @G-Laptop',
    'hint: @WS1 #8 — hey @WS1',
  ]);
  const nonCoord = world({ machine: 'WS1' });
  nonCoord.w.sessions = [lanesSession];
  await nonCoord.obs.poll();
  await nonCoord.obs.poll();
  assert.deepEqual(nonCoord.w.sinceAsked, []);
});
