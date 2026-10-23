import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isValidMachineName, readMachineName, writeMachineName, provenanceEnv, codexShellEnv,
  sessionEnv, SESSION_ENV, readGitUserName,
} from './machine.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'machine-'));

test('provenance can use Git effective identity without writing a global user profile', () => {
  const calls = [];
  const name = readGitUserName((_git, args) => {
    calls.push(args);
    if (args[0] === 'config') throw new Error('unset');
    return 'Developer <developer@example.com> 123456 +0000\n';
  });
  assert.equal(name, 'Developer');
  assert.deepEqual(calls, [['config', '--global', 'user.name'], ['var', 'GIT_AUTHOR_IDENT']]);
  assert.equal(readGitUserName(() => { throw new Error('no git'); }), null);
});

test('isValidMachineName: [A-Za-z0-9-]+ only', () => {
  for (const ok of ['host-c', 'host-a', 'host-d']) assert.equal(isValidMachineName(ok), true);
  for (const bad of ['', ' ', 'a b', 'WS_1', 'x/y', null, 42]) assert.equal(isValidMachineName(bad), false);
});

test('readMachineName: null when missing, unparsable, or invalid', () => {
  const d = tmp();
  assert.equal(readMachineName(join(d, 'nope.json')), null);
  writeFileSync(join(d, 'bad.json'), '{');
  assert.equal(readMachineName(join(d, 'bad.json')), null);
  writeFileSync(join(d, 'inv.json'), '{"name":"a b"}');
  assert.equal(readMachineName(join(d, 'inv.json')), null);
});

test('writeMachineName round-trips and rejects invalid names', () => {
  const p = join(tmp(), 'sub', 'machine.json');
  writeMachineName('host-b', p);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { name: 'host-b' });
  assert.equal(readMachineName(p), 'host-b');
  assert.throws(() => writeMachineName('bad name', p));
});

test('provenanceEnv: nothing without a machine name', () => {
  assert.deepEqual(provenanceEnv({ machine: null, agent: 'claude', userName: 'Me', env: {} }), {});
});

test('provenanceEnv: committer name + HARNESS_*, never author', () => {
  const out = provenanceEnv({ machine: 'host-a', agent: 'codex', userName: 'Me', env: {} });
  assert.deepEqual(out, {
    HARNESS_MACHINE: 'host-a', HARNESS_AGENT: 'codex', GIT_COMMITTER_NAME: 'Me (host-a/codex)',
  });
  assert.ok(!Object.keys(out).some((k) => k.startsWith('GIT_AUTHOR')));
});

test('provenanceEnv: no git user.name -> HARNESS_* only', () => {
  assert.deepEqual(provenanceEnv({ machine: 'host-a', agent: 'claude', userName: null, env: {} }),
    { HARNESS_MACHINE: 'host-a', HARNESS_AGENT: 'claude' });
});

test('provenanceEnv: keeps a user-set committer name, replaces an inherited launcher one', () => {
  const user = provenanceEnv({ machine: 'host-a', agent: 'claude', userName: 'Me',
    env: { GIT_COMMITTER_NAME: 'Custom' } });
  assert.equal('GIT_COMMITTER_NAME' in user, false);
  const nested = provenanceEnv({ machine: 'host-a', agent: 'claude', userName: 'Me',
    env: { GIT_COMMITTER_NAME: 'Me (host-a/codex)', HARNESS_AGENT: 'codex' } });
  assert.equal(nested.GIT_COMMITTER_NAME, 'Me (host-a/claude)');
});

test('codexShellEnv: fixed codex provenance, independent of the calling env', () => {
  assert.deepEqual(codexShellEnv({ machine: null, userName: 'Me' }), {});
  assert.deepEqual(codexShellEnv({ machine: 'host-a', userName: 'Me' }), {
    HARNESS_MACHINE: 'host-a', HARNESS_AGENT: 'codex', GIT_COMMITTER_NAME: 'Me (host-a/codex)',
  });
});

test('sessionEnv: issues one fresh id per session, independent of the machine name', () => {
  const a = sessionEnv({}), b = sessionEnv({});
  assert.equal(SESSION_ENV, 'LAB_SESSION');
  assert.match(a.LAB_SESSION, /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);
  assert.notEqual(a.LAB_SESSION, b.LAB_SESSION);
});

test('sessionEnv: a child launched inside a session inherits its id (codex/ccds under ccc alike)', () => {
  assert.deepEqual(sessionEnv({ LAB_SESSION: 'outer-session-1' }), { LAB_SESSION: 'outer-session-1' });
});

test('sessionEnv: native Codex lineage replaces stale launcher IDs without inventing an ID', () => {
  assert.deepEqual(sessionEnv({ CODEX_SESSION_ID: 'root', CODEX_THREAD_ID: 'child', LAB_SESSION: 'stale' }), { LAB_SESSION: 'root' });
  assert.deepEqual(sessionEnv({ CODEX_THREAD_ID: 'main' }), { LAB_SESSION: 'main' });
});
