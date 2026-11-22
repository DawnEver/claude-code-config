import test from 'node:test';
import assert from 'node:assert/strict';
import { readMachineRepos, REPOS_DOOR } from './machine-repos.mjs';
import { ownPython } from './own-python.mjs';

const ran = (stdout, status = 0, stderr = '') => () => ({ stdout, status, stderr });

test('the machine file [repos] is read once through lab_commons, under cc-config\'s own interpreter', () => {
  let argv;
  const got = readMachineRepos({ run: (p, a) => { argv = [p, ...a]; return ran(JSON.stringify({ 'dev-lab': 'C:/w/dev-lab' }))(); } });
  assert.deepEqual(got, { repos: { 'dev-lab': 'C:/w/dev-lab' }, why: null });
  assert.deepEqual(argv, [ownPython(), ...REPOS_DOOR]);
});

test('a failed door is no repos, with why', () => {
  const missing = readMachineRepos({ python: 'py', run: () => ({ error: new Error('ENOENT') }) });
  assert.equal(missing.repos, null);
  assert.match(missing.why, /setup\.js/);
  const failed = readMachineRepos({ python: 'py', run: ran('', 1, 'ModuleNotFoundError: lab_commons') });
  assert.equal(failed.repos, null);
  assert.match(failed.why, /lab_commons/);
  assert.match(readMachineRepos({ python: 'py', run: ran('not json') }).why, /no JSON/);
});
