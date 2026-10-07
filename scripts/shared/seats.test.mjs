import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { isValidAlias, baseDir, seatDir, configDir, aliasOf, accountFile, usageFile, seatsFor, resolveSeat } from './seats.mjs';

test('resolveSeat: exact, else a unique prefix, else a unique near typo; otherwise list every seat', () => {
  const aliases = ['alpha', 'beta', 'bravo'];
  assert.deepEqual(resolveSeat('beta', aliases), { alias: 'beta', match: 'exact' });
  assert.deepEqual(resolveSeat('Al', aliases), { alias: 'alpha', match: 'prefix' }, 'prefix, case-insensitive');
  assert.deepEqual(resolveSeat('alpah', aliases), { alias: 'alpha', match: 'typo' }, 'transposed letters');
  assert.deepEqual(resolveSeat('bet', aliases), { alias: 'beta', match: 'prefix' });
  assert.match(resolveSeat('b', aliases).error, /unknown seat "b"; seats on this machine: alpha, beta, bravo/, 'ambiguous prefix');
  assert.match(resolveSeat('zzzzz', aliases).error, /alpha, beta, bravo/);
  assert.match(resolveSeat('', aliases).error, /unknown seat ""/);
  assert.match(resolveSeat('x', []).error, /none \(add this machine/);
});

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

test('a seat runs in the base dir when the base login holds it, else in its own dir', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seats-home-'));
  const { readAccount, baseSeat, seatHome, seatOf } = await import('./seats.mjs');
  try {
    fs.mkdirSync(baseDir(home));
    const seats = [{ alias: 'team-a', email: 'a@x', org: 'Team A', machines: ['m1'] }, { alias: 'team-b', email: 'a@x', org: 'Team B', machines: ['m1'] }];
    assert.equal(baseSeat(seats, 'm1', home), null, 'not logged in: holds no seat');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'A@x', organizationName: 'Uni Team B', organizationUuid: 'u2' } }));
    assert.deepEqual(readAccount(baseDir(home), home), { email: 'A@x', org: 'Uni Team B', orgUuid: 'u2' });
    assert.equal(baseSeat(seats, 'm1', home), 'team-b');
    assert.equal(seatHome('team-b', seats, 'm1', home), baseDir(home));
    assert.equal(seatHome('team-a', seats, 'm1', home), seatDir('team-a', home));
    assert.equal(seatOf(baseDir(home), seats, 'm1', home), 'team-b');
    assert.equal(seatOf(seatDir('team-a', home), seats, 'm1', home), 'team-a');
    assert.equal(baseSeat(seats, 'm2', home), null, 'another machine\'s seats never match');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
