import test from 'node:test';
import assert from 'node:assert/strict';
import { readMarketDir, MARKET_DOOR, MARKET_FIX } from './market-dir.mjs';

const ran = (stdout, status = 0, stderr = '') => () => ({ stdout, status, stderr });

test('the declared [repos] cc-market is the one location', () => {
  const got = readMarketDir({ python: 'py', run: ran(JSON.stringify({ 'cc-market': 'C:/w/cc-market', 'dev-lab': 'C:/w/dev-lab' })) });
  assert.deepEqual(got, { dir: 'C:/w/cc-market', why: null });
});

test('an undeclared cc-market refuses by name and names its door, never a guessed path', () => {
  const got = readMarketDir({ python: 'py', run: ran(JSON.stringify({ 'dev-lab': 'C:/w/dev-lab' })) });
  assert.equal(got.dir, null);
  assert.match(got.why, /cc-market is not declared/);
  assert.match(got.why, /devhost local set repos\.cc-market/);
  assert.match(MARKET_FIX, /devhost local set repos\.cc-market/);
});

test('a failed door or a missing python is no location, with why', () => {
  assert.equal(readMarketDir({ python: null }).dir, null);
  const failed = readMarketDir({ python: 'py', run: ran('', 1, 'ModuleNotFoundError: lab_commons') });
  assert.equal(failed.dir, null);
  assert.match(failed.why, /lab_commons/);
  assert.equal(readMarketDir({ python: 'py', run: ran('not json') }).dir, null);
});

test('the door reads the machine file through lab_commons, not a second TOML reader', () => {
  assert.equal(MARKET_DOOR[0], '-c');
  assert.match(MARKET_DOOR[1], /lab_commons\.home import repos/);
});
