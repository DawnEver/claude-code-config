import test from 'node:test';
import assert from 'node:assert/strict';
import { readMachineRepos, devLabPython, REPOS_DOOR, DEV_LAB_FIX } from './machine-repos.mjs';

const ran = (stdout, status = 0, stderr = '') => () => ({ stdout, status, stderr });

test('the machine file [repos] is read once through lab_commons', () => {
  let argv;
  const got = readMachineRepos({ python: 'py', run: (p, a) => { argv = [p, ...a]; return ran(JSON.stringify({ 'dev-lab': 'C:/w/dev-lab' }))(); } });
  assert.deepEqual(got, { repos: { 'dev-lab': 'C:/w/dev-lab' }, why: null });
  assert.deepEqual(argv, ['py', ...REPOS_DOOR]);
});

test('a failed door or a missing python is no repos, with why', () => {
  assert.equal(readMachineRepos({ python: null }).repos, null);
  const failed = readMachineRepos({ python: 'py', run: ran('', 1, 'ModuleNotFoundError: lab_commons') });
  assert.equal(failed.repos, null);
  assert.match(failed.why, /lab_commons/);
  assert.match(readMachineRepos({ python: 'py', run: ran('not json') }).why, /no JSON/);
});

// 2026-11-21: the channel declaration ran dev_lab under ai-lab's interpreter, which has no dev_lab, so every
// Telegram message was undeclared. dev-lab's doors run under the dev-lab checkout's own environment.
test('dev-lab doors run under the declared dev-lab checkout environment, per platform layout', () => {
  const read = () => ({ repos: { 'dev-lab': 'C:/w/dev-lab' }, why: null });
  assert.deepEqual(devLabPython({ read, platform: 'win32' }), { python: 'C:/w/dev-lab/.venv/Scripts/python.exe', why: null });
  assert.deepEqual(devLabPython({ read: () => ({ repos: { 'dev-lab': '/w/dev-lab' }, why: null }), platform: 'linux' }), { python: '/w/dev-lab/.venv/bin/python', why: null });
});

test('an undeclared dev-lab checkout is no interpreter, naming its door; never a guessed one', () => {
  const none = devLabPython({ read: () => ({ repos: { 'cc-market': 'C:/w/cc-market' }, why: null }), platform: 'win32' });
  assert.equal(none.python, null);
  assert.match(none.why, /devhost local set repos\.dev-lab/);
  assert.match(DEV_LAB_FIX, /repos\.dev-lab/);
  assert.equal(devLabPython({ read: () => ({ repos: null, why: 'door failed: x' }), platform: 'win32' }).why, 'door failed: x');
});
