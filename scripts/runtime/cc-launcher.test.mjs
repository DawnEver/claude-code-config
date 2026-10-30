// Unit tests for scripts/runtime/cc-launcher.mjs — the env + args projection
// that `cc.js` uses to spawn the `claude` binary.
//
// The catalogue (provider cache) and the key (credential store) are injected; local file
// paths are a temp dir; the real ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildClaudeInvocation } from './cc-launcher.mjs';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readProviderCache } from '../shared/provider-cache.mjs';
import { fakeAiLab, writeCache } from '../shared/provider-cache-fixture.mjs';


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-launcher-'));
  return {
    shared: join(dir, 'claude_env_settings.json'),
    local: join(dir, 'claude_env_settings.local.json'),
  };
}

test('default Claude (provider=null) leaves env untouched beyond PROVIDER_KEYS strip', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, '{}');
  const before = { ...process.env };
  const { env, args, provider: used, error } = buildClaudeInvocation({
    provider: null, extraArgs: ['--foo'], envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(used, null);
  assert.deepEqual(args, ['--foo']);
  for (const k of PROVIDER_KEYS) {
    if (before[k] != null) assert.equal(env[k], undefined, `${k} should be stripped from parent env`);
  }
});

// The catalogue comes from the provider cache, the key from the credential store: both injected.
const lab = fakeAiLab();
const cachePath = writeCache(lab);
const readCache = () => readProviderCache({ path: cachePath });
const keys = (store = { 'api.deepseek.com/api-key-session': 'sk-secret' }) =>
  ({ host, username }) => (store[`${host}/${username}`] ? { key: store[`${host}/${username}`] } : { error: `no key ${username}@${host}` });

function invoke(shared, local, opts = {}) {
  const f = fixture();
  writeFileSync(f.shared, JSON.stringify(shared));
  writeFileSync(f.local, JSON.stringify(local ?? {}));
  return buildClaudeInvocation({ provider: 'deepseek', envSettingsPath: f.shared, localPath: f.local,
    readCache, fetchKey: keys(), ...opts });
}

const RULES = { providers: { deepseek: { claudeApiKeyEnv: 'ANTHROPIC_API_KEY', codexApiKeyEnv: 'DEEPSEEK_API_KEY' } } };

test('deepseek: base URL and role models from the catalogue, key from the store into claudeApiKeyEnv', () => {
  const { env, error } = invoke(RULES);
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.HARNESS_PROVIDER, 'deepseek', 'the bridge attributes the session to this platform');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-secret');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-flash[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-flash[1m]');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-flash[1m]');
});

test('the key is read for the catalogue session username at the catalogue host', () => {
  let asked;
  invoke(RULES, {}, { fetchKey: (q) => { asked = q; return { key: 'k' }; } });
  assert.deepEqual(asked, { host: 'api.deepseek.com', username: 'api-key-session' });
});

test('the env var the key goes into is the projection rule (ANTHROPIC_AUTH_TOKEN works too)', () => {
  const { env } = invoke({ providers: { deepseek: { claudeApiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' } } });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-secret');
});

test('no key in the store refuses the launch, naming username and host', () => {
  const { error } = invoke(RULES, {}, { fetchKey: keys({}) });
  assert.match(error, /no key api-key-session@api\.deepseek\.com/);
});

test('a stale or absent cache refuses the launch naming the remedy', () => {
  const { error } = invoke(RULES, {}, { readCache: () => readProviderCache({ path: join(lab.dir, 'absent.json') }) });
  assert.match(error, /provider-cache|absent/);
  assert.match(error, /node scripts\/setup\/setup\.js/);
});

test('a provider without projection rules is unknown, listing the available ones', () => {
  const { error, available } = invoke(RULES, {}, { provider: 'kimi' });
  assert.match(error, /Unknown provider: kimi/);
  assert.deepEqual(available, ['deepseek']);
});

test('a provider with rules but no catalogue row refuses', () => {
  const { error } = invoke({ providers: { gmi: { claudeApiKeyEnv: 'X' } } }, {}, { provider: 'gmi' });
  assert.match(error, /gmi is not in the ai-lab catalogue/);
});

for (const [field, value, where] of [
  ['url', 'https://api.deepseek.com', 'shared'], ['claudePath', '/anthropic', 'shared'],
  ['codexPath', '/v1', 'shared'], ['models', { base: 'x' }, 'shared'], ['apiKey', 'sk-old', 'local'],
]) {
  test(`retired field providers.deepseek.${field} (${where}) is refused by name`, () => {
    const block = { providers: { deepseek: { [field]: value } } };
    const { error } = where === 'shared'
      ? invoke({ providers: { deepseek: { ...RULES.providers.deepseek, [field]: value } } })
      : invoke(RULES, block);
    assert.match(error, new RegExp(`retired provider field.*providers\.deepseek\.${field} ->`));
  });
}

test('missing shared file returns a clear error', () => {
  const { error } = buildClaudeInvocation({ provider: 'deepseek', envSettingsPath: '/nonexistent/x.json', readCache, fetchKey: keys() });
  assert.match(error, /Missing: /);
});

test('extraArgs pass through unchanged', () => {
  const { args } = invoke(RULES, {}, { extraArgs: ['-r', 'find . -name "*.ts"'] });
  assert.deepEqual(args.slice(-2), ['-r', 'find . -name "*.ts"']);
});

// ── provenance (docs/harness-architecture.md §8b) ──

test('provenance: machine name -> committer + HARNESS_* for claude, author untouched', () => {
  const { env } = buildClaudeInvocation({ provider: null, envSettingsPath: '/nonexistent',
    machine: 'WS9', gitUserName: 'Me' });
  assert.equal(env.HARNESS_MACHINE, 'WS9');
  assert.equal(env.HARNESS_AGENT, 'claude');
  assert.equal(env.GIT_COMMITTER_NAME, 'Me (WS9/claude)');
  assert.equal(env.GIT_AUTHOR_NAME, process.env.GIT_AUTHOR_NAME);
});

test('provenance: no machine name -> nothing injected', () => {
  const { env } = buildClaudeInvocation({ provider: null, envSettingsPath: '/nonexistent',
    machine: null, gitUserName: 'Me' });
  assert.equal(env.HARNESS_MACHINE, process.env.HARNESS_MACHINE);
});

// ── session bridge channel (docs/bridge.md) ──

const CHANNEL_ARGS = ['--dangerously-load-development-channels', 'server:session-bridge'];

function bridgeFixture(botToken) {
  const f = fixture();
  writeFileSync(f.shared, JSON.stringify({
    providers: { deepseek: { claudeApiKeyEnv: 'ANTHROPIC_API_KEY' } },
    bridge: { fallbackChatId: -100, projects: {} },
  }));
  writeFileSync(f.local, JSON.stringify(botToken ? { bridge: { botToken } } : {}));
  return f;
}

test('bridge: a configured bot token loads the session-bridge channel on official Claude', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const { args } = buildClaudeInvocation({ provider: null, extraArgs: ['--verbose'], envSettingsPath: shared, localPath: local });
  assert.deepEqual(args, [...CHANNEL_ARGS, '--verbose']);
});

test('bridge: no bot token -> no channel flag', () => {
  const { shared, local } = bridgeFixture(null);
  const { args } = buildClaudeInvocation({ provider: null, envSettingsPath: shared, localPath: local });
  assert.deepEqual(args, []);
});

test('bridge: a third-party provider never gets the channel (channels need Anthropic auth)', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const { args, error } = buildClaudeInvocation({ provider: 'deepseek', envSettingsPath: shared, localPath: local, readCache, fetchKey: keys() });
  assert.equal(error, null);
  assert.ok(!args.includes('--dangerously-load-development-channels'));
});

test('bridge: an explicit channel flag from the user is not duplicated', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const { args } = buildClaudeInvocation({ provider: null, extraArgs: [...CHANNEL_ARGS], envSettingsPath: shared, localPath: local });
  assert.deepEqual(args, CHANNEL_ARGS);
});

test('--seat points CLAUDE_CONFIG_DIR at the seat dir; without it the base dir is used', async () => {
  const { mkdirSync } = await import('node:fs');
  const { shared, local } = fixture();
  writeFileSync(shared, '{}');
  const home = mkdtempSync(join(tmpdir(), 'cc-seat-home-'));
  mkdirSync(join(home, '.claude-team-b'));
  const seats = [{ alias: 'team-a', machines: ['m1'] }, { alias: 'team-b', machines: ['m1'] }];
  const run = (o) => buildClaudeInvocation({ provider: null, envSettingsPath: shared, localPath: local, machine: 'm1', gitUserName: null, home, seats, ...o });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude-other');
  try {
    assert.equal(run({ seat: 'team-b' }).env.CLAUDE_CONFIG_DIR, join(home, '.claude-team-b'));
    assert.equal(run({}).env.CLAUDE_CONFIG_DIR, undefined, 'an inherited seat never leaks into plain ccc');
    assert.match(run({ seat: 'team-a' }).error, /no seat dir .*run setup/);
    assert.match(run({ seat: '../x' }).error, /unknown seat "\.\.\/x"; seats on this machine: team-a, team-b/);
    assert.match(run({ seat: 'team-b', provider: 'deepseek' }).error, /subscription login/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('--seat for the seat the base login holds runs in the base dir, like plain ccc', async () => {
  const { mkdirSync } = await import('node:fs');
  const { shared, local } = fixture();
  writeFileSync(shared, '{}');
  const home = mkdtempSync(join(tmpdir(), 'cc-seat-base-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x', organizationName: 'Team B' } }));
  const seats = [{ alias: 'team-b', email: 'a@x', org: 'Team B', machines: ['m1'] }];
  const { env, error } = buildClaudeInvocation({ provider: null, envSettingsPath: shared, localPath: local, machine: 'm1', gitUserName: null, home, seats, seat: 'team-b' });
  assert.equal(error, null);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
});

test('a partial seat name reports what it matched and how', async () => {
  const { mkdirSync } = await import('node:fs');
  const { shared, local } = fixture();
  writeFileSync(shared, '{}');
  const home = mkdtempSync(join(tmpdir(), 'cc-seat-match-'));
  mkdirSync(join(home, '.claude-team-a'));
  const seats = [{ alias: 'team-a', machines: ['m1'] }];
  const run = (seat) => buildClaudeInvocation({ provider: null, envSettingsPath: shared, localPath: local, machine: 'm1', gitUserName: null, home, seats, seat });
  assert.deepEqual([run('t').seat, run('t').seatMatch], ['team-a', 'prefix']);
  assert.deepEqual([run('taem-a').seat, run('taem-a').seatMatch], ['team-a', 'typo']);
  assert.deepEqual([run('team-a').seat, run('team-a').seatMatch], ['team-a', 'exact']);
});

test('withKey: false projects url and models but never reads or sets the key (setup-vscode)', () => {
  const { env, error } = invoke(RULES, {}, { withKey: false, fetchKey: () => assert.fail('must not read the key') });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});
