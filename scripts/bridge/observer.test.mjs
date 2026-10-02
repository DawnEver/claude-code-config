import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Observer, provenanceOf } from './observer.mjs';

/**
 * A fake world: one repo at /r with remote tips, commits (sha -> committer) and statuses the
 * test edits between polls.
 */
function world({ family = true } = {}) {
  const w = {
    tips: { main: 'a0' },
    commits: {},          // range "old..new" or "new" -> [{sha, committer}]
    statuses: {},         // sha -> [{context, state}]
    locked: false,
    branchOf: { '/r/sub': 'feat/x' },
    sessions: [],
    posts: [], forgeCalls: [], fetches: 0,
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
    w.forgeCalls.push(args[0]);
    if (!family) return null;
    if (args[0] === 'status') return w.statuses[args[2]] ?? [];
    return null;
  };
  const obs = new Observer({
    git, forge, cacheFile: null,
    exists: (p) => w.locked && p.endsWith('index.lock'),
    sessions: () => w.sessions,
    post: (key, text) => w.posts.push([key, text]),
  });
  return { w, obs };
}

const mainSession = { key: 'codex:main', cwd: '/r', chatId: -100, project: 'p' };
const subSession = { key: 'claude:s', cwd: '/r/sub', chatId: -100, project: 'p' };

test('provenanceOf reads `Name (<machine>/<agent>)` from a committer name', () => {
  assert.deepEqual(provenanceOf('Me (host-a/codex)'), { machine: 'host-a', agent: 'codex' });
  assert.equal(provenanceOf('Me'), null);
});

test('the first poll of a repo only seeds; later moves go to the one session on that branch, whoever pushed', async () => {
  const { w, obs } = world();
  w.sessions = [mainSession, subSession];
  await obs.poll();
  assert.deepEqual(w.posts, [], 'nothing historic is reported');

  w.tips['feat/x'] = 'b2';
  w.commits['b2 --not a0'] = [{ sha: 'b2', committer: 'M (host-c/claude)' }, { sha: 'b1', committer: 'M (host-c/claude)' }];
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M (host-a/codex)' }];
  w.tips['feat/none'] = 'e1';
  w.commits['e1 --not a0'] = [{ sha: 'e1', committer: 'M' }];
  await obs.poll();
  await obs.poll();
  assert.deepEqual(w.posts, [['claude:s', 'pushed b2 → feat/x (+2)']], 'no session on main/feat/none -> dropped');
  assert.ok(!w.forgeCalls.includes('issue'), 'issues are read on the forge, not here');
});

test('a push by another machine or a human is reported into the session on that branch', async () => {
  const { w, obs } = world();
  w.sessions = [{ ...mainSession }];
  w.branchOf['/r'] = 'main';
  await obs.poll();
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M (host-c/claude)' }];
  await obs.poll();
  w.tips.main = 'a2';
  w.commits['a1..a2'] = [{ sha: 'a2', committer: 'M' }];
  await obs.poll();
  assert.deepEqual(w.posts, [['codex:main', 'pushed a1 → main (+1)'], ['codex:main', 'pushed a2 → main (+1)']]);
});

test('lab/gate and lab/heavy verdicts on a reported tip follow it, once each', async () => {
  const { w, obs } = world();
  w.sessions = [mainSession, subSession];
  await obs.poll();
  w.tips['feat/x'] = 'b2';
  w.commits['b2 --not a0'] = [{ sha: 'b2', committer: 'M (host-c/claude)' }];
  await obs.poll();
  w.statuses.b2 = [{ context: 'lab/gate', state: 'success' }, { context: 'lab/test', state: 'success' }];
  await obs.poll();
  w.statuses.b2 = [{ context: 'lab/gate', state: 'success' }, { context: 'lab/heavy', state: 'failure' }, { context: 'lab/test', state: 'success' }];
  await obs.poll();
  await obs.poll();
  assert.deepEqual(w.posts.map(([, t]) => t), ['pushed b2 → feat/x (+1)', 'lab/gate PASS b2', 'lab/heavy FAIL b2']);
});

test('a held index.lock skips the repo; a non-family repo still gets the git part', async () => {
  const { w, obs } = world({ family: false });
  w.sessions = [{ ...mainSession }];
  w.branchOf['/r'] = 'main';
  w.locked = true;
  await obs.poll();
  assert.equal(w.fetches, 0);
  w.locked = false;
  await obs.poll();
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M' }];
  await obs.poll();
  assert.deepEqual(w.posts.map(([, t]) => t), ['pushed a1 → main (+1)']);
});

test("several sessions on one branch: the pushing agent's session, else dropped — never a guess", async () => {
  const { w, obs } = world();
  w.sessions = [{ ...mainSession }, { ...mainSession, key: 'claude:m' }];
  w.branchOf['/r'] = 'main';
  await obs.poll();
  w.tips.main = 'a1';
  w.commits['a0..a1'] = [{ sha: 'a1', committer: 'M (host-c/claude)' }];
  await obs.poll();
  w.tips.main = 'a2';
  w.commits['a1..a2'] = [{ sha: 'a2', committer: 'M' }];
  await obs.poll();
  assert.deepEqual(w.posts, [['claude:m', 'pushed a1 → main (+1)']]);
});
