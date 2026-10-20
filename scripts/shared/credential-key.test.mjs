import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchKey, keyFingerprint, sessionUsername } from './credential-key.mjs';

test('fetchKey asks git credential fill for https://<username>@<host> with prompts off', () => {
  let call;
  const run = (cmd, args, opts) => { call = { cmd, args, opts }; return { status: 0, stdout: 'protocol=https\nhost=h\nusername=u\npassword=sk-1\r\n' }; };
  assert.deepEqual(fetchKey({ host: 'api.deepseek.com', username: 'api-key-session', run }), { key: 'sk-1' });
  assert.equal(call.cmd, 'git');
  assert.deepEqual(call.args, ['credential', 'fill']);
  assert.equal(call.opts.input, 'protocol=https\nhost=api.deepseek.com\nusername=api-key-session\n\n');
  assert.equal(call.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(call.opts.env.GCM_INTERACTIVE, 'never');
});

test('no stored key refuses naming the username, host and the login command, never a key', () => {
  const run = () => ({ status: 128, stdout: '', stderr: 'fatal: could not read Password' });
  const { error, key } = fetchKey({ host: 'api.deepseek.com', username: 'api-key-session', run });
  assert.equal(key, undefined);
  assert.match(error, /no key api-key-session@api\.deepseek\.com .* ai_lab\.auth login <provider> --task session/);
});

test('planted refusal: no git refuses by name', () => {
  const run = () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
  assert.match(fetchKey({ host: 'h', username: 'u', run }).error, /^no git: /);
});

test('the session username comes from the catalogue row, never derived', () => {
  assert.deepEqual(sessionUsername('deepseek', { key_usernames: { session: 'api-key-session' } }), { username: 'api-key-session' });
  assert.match(sessionUsername('deepseek', { key_usernames: { default: 'api-key' } }).error,
    /deepseek has no 'session' key username .*API_KEY_TASKS/);
});

test('a fingerprint is a sha256 prefix, not the key', () => {
  assert.equal(keyFingerprint('sk-1').length, 12);
  assert.ok(!keyFingerprint('sk-1').includes('sk-1'));
});
