import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredAllowlist, STALE_ALLOWLIST_KEY, CHANNEL_SOURCE } from './channel-declaration.mjs';

const declared = (id) => ({ channels: { [CHANNEL_SOURCE]: id }, why: null });

test('the allowlist is exactly the declared session-bridge user', () => {
  assert.deepEqual(declaredAllowlist({ declaration: declared('1001') }), { allowedUserIds: [1001], why: null, stale: null });
  // Planted control: a sender the declaration does not name is not in it.
  assert.equal(declaredAllowlist({ declaration: declared('1001') }).allowedUserIds.includes(2002), false);
});

test('an unreadable or missing declaration accepts nobody and names the door to fix', () => {
  const cases = {
    'door failed': { channels: {}, why: 'door failed: exit 2' },
    'nothing declared': { channels: {}, why: 'nothing declared' },
    'another source only': { channels: { other: '1001' }, why: null },
    'not a user id': declared('@alice'),
  };
  for (const [name, declaration] of Object.entries(cases)) {
    const got = declaredAllowlist({ declaration });
    assert.deepEqual(got.allowedUserIds, [], name);
    assert.match(got.why, /hosts-config hosts\/<machine>\.toml \[dev\] channels/, name);
  }
});

test('a leftover bridge.allowedUserIds is never read, only named', () => {
  const got = declaredAllowlist({ declaration: declared('1001'), bridge: { allowedUserIds: [666] } });
  assert.deepEqual(got.allowedUserIds, [1001], 'the declared id, not the local key');
  assert.equal(got.stale, STALE_ALLOWLIST_KEY);
  assert.match(got.stale, /bridge\.allowedUserIds.*remove this key/);
  // Fail closed even with a stale key present: it never becomes a fallback.
  assert.deepEqual(declaredAllowlist({ declaration: { channels: {}, why: 'x' }, bridge: { allowedUserIds: [666] } }).allowedUserIds, []);
});
