import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { isValidAlias, baseDir, seatDir, configDir, aliasOf, accountFile, usageFile, seatsFor } from './seats.mjs';

const HOME = path.resolve('/home/u');

test('an alias is a lowercase filename-safe word on every platform', () => {
  assert.deepEqual(['team-a', 'team-b', 'team-2'].map(isValidAlias), [true, true, true]);
  assert.deepEqual(['', 'Team-b', '../x', 'a b', '-x', null].map(isValidAlias), [false, false, false, false, false, false]);
});

test('alias <-> dir round-trips; the base dir and foreign dirs have no alias', () => {
  assert.equal(seatDir('team-b', HOME), path.join(HOME, '.claude-team-b'));
  assert.equal(aliasOf(seatDir('team-b', HOME), HOME), 'team-b');
  assert.equal(aliasOf(baseDir(HOME), HOME), null);
  assert.equal(aliasOf(path.join(HOME, 'x', '.claude-team-b'), HOME), null);
  assert.equal(aliasOf(path.join(HOME, '.claude-Team-b'), HOME), null);
});

test('configDir follows CLAUDE_CONFIG_DIR, else the base dir', () => {
  assert.equal(configDir({}, HOME), baseDir(HOME));
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: seatDir('team-b', HOME) }, HOME), seatDir('team-b', HOME));
});

test('the base keeps .claude.json in home; a seat keeps it inside its dir', () => {
  assert.equal(accountFile(baseDir(HOME), HOME), path.join(HOME, '.claude.json'));
  assert.equal(accountFile(seatDir('team-b', HOME), HOME), path.join(HOME, '.claude-team-b', '.claude.json'));
  assert.equal(usageFile(seatDir('team-b', HOME)), path.join(HOME, '.claude-team-b', 'bridge', 'claude-usage.json'));
});

test('seatsFor returns this machine\'s seats normalised and survives junk', () => {
  const seats = [{ alias: 'team-a', email: 'a@x', machines: ['m1'] }, { alias: 'Bad', email: 'b@x', machines: ['m1'], claimed: [1] },
    { alias: 'team-b', machines: ['m2'] }, null, 3, { machines: 'm1' }];
  assert.deepEqual(seatsFor(seats, 'm1'), [
    { alias: 'team-a', email: 'a@x', org: null, orgUuid: null, claimed: [] },
    { alias: null, email: 'b@x', org: null, orgUuid: null, claimed: ['1'] }]);
  for (const bad of [null, 'x', {}]) assert.deepEqual(seatsFor(bad, 'm1'), []);
});
