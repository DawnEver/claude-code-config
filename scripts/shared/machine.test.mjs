import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isValidMachineName, readMachineName, writeMachineName, provenanceEnv,
} from './machine.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'machine-'));

test('isValidMachineName: [A-Za-z0-9-]+ only', () => {
  for (const ok of ['G-Laptop', 'WS1', 'WSEng']) assert.equal(isValidMachineName(ok), true);
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
  writeMachineName('WS2', p);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { name: 'WS2' });
  assert.equal(readMachineName(p), 'WS2');
  assert.throws(() => writeMachineName('bad name', p));
});

test('provenanceEnv: nothing without a machine name', () => {
  assert.deepEqual(provenanceEnv({ machine: null, agent: 'claude', userName: 'Me', env: {} }), {});
});

test('provenanceEnv: committer name + HARNESS_*, never author', () => {
  const out = provenanceEnv({ machine: 'WS1', agent: 'codex', userName: 'Me', env: {} });
  assert.deepEqual(out, {
    HARNESS_MACHINE: 'WS1', HARNESS_AGENT: 'codex', GIT_COMMITTER_NAME: 'Me (WS1/codex)',
  });
  assert.ok(!Object.keys(out).some((k) => k.startsWith('GIT_AUTHOR')));
});

test('provenanceEnv: no git user.name -> HARNESS_* only', () => {
  assert.deepEqual(provenanceEnv({ machine: 'WS1', agent: 'claude', userName: null, env: {} }),
    { HARNESS_MACHINE: 'WS1', HARNESS_AGENT: 'claude' });
});

test('provenanceEnv: keeps a user-set committer name, replaces an inherited launcher one', () => {
  const user = provenanceEnv({ machine: 'WS1', agent: 'claude', userName: 'Me',
    env: { GIT_COMMITTER_NAME: 'Custom' } });
  assert.equal('GIT_COMMITTER_NAME' in user, false);
  const nested = provenanceEnv({ machine: 'WS1', agent: 'claude', userName: 'Me',
    env: { GIT_COMMITTER_NAME: 'Me (WS1/codex)', HARNESS_AGENT: 'codex' } });
  assert.equal(nested.GIT_COMMITTER_NAME, 'Me (WS1/claude)');
});
