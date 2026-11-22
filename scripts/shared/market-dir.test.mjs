import test from 'node:test';
import assert from 'node:assert/strict';
import { readMarketDir, MARKET_FIX } from './market-dir.mjs';
import { REPOS_DOOR } from './machine-repos.mjs';

const read = (repos, why = null) => () => ({ repos, why });

test('the declared [repos] cc-market is the one location', () => {
  const got = readMarketDir({ read: read({ 'cc-market': 'C:/w/cc-market', 'dev-lab': 'C:/w/dev-lab' }) });
  assert.deepEqual(got, { dir: 'C:/w/cc-market', why: null });
});

test('an undeclared cc-market refuses by name and names its door, never a guessed path', () => {
  const got = readMarketDir({ read: read({ 'dev-lab': 'C:/w/dev-lab' }) });
  assert.equal(got.dir, null);
  assert.match(got.why, /cc-market is not declared/);
  assert.match(got.why, /devhost local set repos\.cc-market/);
  assert.match(MARKET_FIX, /devhost local set repos\.cc-market/);
});

test('an unreadable machine file is no location, with why', () => {
  const failed = readMarketDir({ read: read(null, 'door failed: ModuleNotFoundError: lab_commons') });
  assert.equal(failed.dir, null);
  assert.match(failed.why, /lab_commons/);
});

test('the door reads the machine file through lab_commons, not a second TOML reader', () => {
  assert.equal(REPOS_DOOR[0], '-c');
  assert.match(REPOS_DOOR[1], /lab_commons\.home import repos/);
});
