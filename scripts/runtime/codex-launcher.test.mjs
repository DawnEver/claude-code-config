// Unit tests for scripts/runtime/codex-launcher.mjs — the env + CLI-flag
// projection that `codex.js` uses to spawn the `codex` binary.
//
// The codex projection differs from the claude one: `--config model_provider=<name>`
// selects the block setup composes, `--model <name>` (no env var exists), and the key goes
// into the projection rule's env var. The catalogue and the key are injected; the real
// ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildCodexInvocation } from './codex-launcher.mjs';
import { readProviderCache } from '../shared/provider-cache.mjs';
import { fakeAiLab, writeCache } from '../shared/provider-cache-fixture.mjs';

// Provider launches scope the codex model catalog to the absolute
// ~/.codex/models.json (global config would leak 3rd-party models into plain
// `codex`). Computed the same way the launcher does so the assertion is robust.
const CATALOG_FLAG = `model_catalog_json=${join(homedir(), '.codex', 'models.json')}`;

const CODEX_STRIP_KEYS = [
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'CODEX_HOME', 'CODEX_NON_INTERACTIVE', 'CODEX_CA_CERTIFICATE',
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-launcher-'));
  return {
    shared: join(dir, 'claude_env_settings.json'),
    local: join(dir, 'claude_env_settings.local.json'),
  };
}

test('default Codex (provider=null) leaves env untouched beyond strip sets and adds no args', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, '{}');
  const before = { ...process.env };
  const { env, args, provider: used, error } = buildCodexInvocation({
    provider: null, extraArgs: ['--foo'], envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(used, null);
  assert.deepEqual(args, ['--foo']);
  for (const k of CODEX_STRIP_KEYS) {
    if (before[k] != null) assert.equal(env[k], undefined, `${k} should be stripped from parent env`);
  }
});

// The catalogue comes from the provider cache, the key from the credential store: both injected.
const lab = fakeAiLab();
const cachePath = writeCache(lab);
const readCache = () => readProviderCache({ path: cachePath });
const keys = (store = { 'api.deepseek.com/api-key-session': 'sk-secret' }) =>
  ({ host, username }) => (store[`${host}/${username}`] ? { key: store[`${host}/${username}`] } : { error: `no key ${username}@${host}` });
const RULES = { providers: { deepseek: { claudeApiKeyEnv: 'ANTHROPIC_API_KEY', codexApiKeyEnv: 'DEEPSEEK_API_KEY' } } };

function invoke(shared, local, opts = {}) {
  const f = fixture();
  writeFileSync(f.shared, JSON.stringify(shared));
  writeFileSync(f.local, JSON.stringify(local ?? {}));
  return buildCodexInvocation({ provider: 'deepseek', envSettingsPath: f.shared, localPath: f.local,
    readCache, fetchKey: keys(), ...opts });
}

test('deepseek: provider block, scoped catalog and --model from the catalogue base (strips [1m]), key into codexApiKeyEnv', () => {
  const { env, args, error } = invoke(RULES, {}, { extraArgs: ['exec', 'hi'] });
  assert.equal(error, null);
  assert.deepEqual(args, ['--config', 'model_provider=deepseek', '--config', CATALOG_FLAG,
    '--model', 'deepseek-v4-flash', 'exec', 'hi']);
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-secret');
});

test('no key in the store refuses the launch', () => {
  assert.match(invoke(RULES, {}, { fetchKey: keys({}) }).error, /no key api-key-session@api\.deepseek\.com/);
});

test('an absent cache refuses naming the remedy', () => {
  const { error } = invoke(RULES, {}, { readCache: () => readProviderCache({ path: join(lab.dir, 'absent.json') }) });
  assert.match(error, /absent.*node scripts\/setup\/setup\.js/);
});

test('unknown provider lists the available ones', () => {
  const { error } = invoke(RULES, {}, { provider: 'kimi' });
  assert.match(error, /Unknown provider: kimi\. Available: deepseek/);
});

test('retired apiKey in the local file is refused by name', () => {
  const { error, env } = invoke(RULES, { providers: { deepseek: { apiKey: 'sk-old' } } });
  assert.match(error, /providers\.deepseek\.apiKey ->/);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
});

test('missing shared file returns a clear error', () => {
  assert.match(buildCodexInvocation({ provider: 'deepseek', envSettingsPath: '/nonexistent/x.json', readCache, fetchKey: keys() }).error, /Missing: /);
});

// ── provenance (docs/harness-architecture.md §8b) ──

test('provenance: the codex launcher injects nothing (config.toml shell_environment_policy does)', () => {
  const { env } = buildCodexInvocation({ provider: null, envSettingsPath: '/nonexistent' });
  assert.equal(env.HARNESS_MACHINE, process.env.HARNESS_MACHINE);
  assert.equal(env.HARNESS_AGENT, process.env.HARNESS_AGENT);
  assert.equal(env.GIT_COMMITTER_NAME, process.env.GIT_COMMITTER_NAME);
});

test('session: the codex launcher issues LAB_SESSION (config.toml cannot: it is per session)', () => {
  const { env } = buildCodexInvocation({ provider: null, envSettingsPath: '/nonexistent' });
  assert.ok(env.LAB_SESSION);
});

// ── session bridge: the TUI must attach to the shared app-server (docs/bridge.md) ──

function bridgeFixture(botToken) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-'));
  const shared = join(dir, 'claude_env_settings.json');
  const local = join(dir, 'claude_env_settings.local.json');
  writeFileSync(shared, JSON.stringify({ providers: { deepseek: { codexApiKeyEnv: 'DEEPSEEK_API_KEY' } } }));
  writeFileSync(local, JSON.stringify(botToken ? { bridge: { botToken } } : {}));
  return { shared, local };
}

test('bridge: interactive official TUI attaches to the shared daemon', () => {
  const { shared, local } = bridgeFixture('123:abc');
  assert.deepEqual(buildCodexInvocation({ provider: null, envSettingsPath: shared, localPath: local }).args,
    ['--remote', 'unix://']);
  assert.deepEqual(buildCodexInvocation({ provider: null, extraArgs: ['fix the build'], envSettingsPath: shared, localPath: local }).args,
    ['--remote', 'unix://', 'fix the build']);
  assert.deepEqual(buildCodexInvocation({ provider: null, extraArgs: ['resume', '--last'], envSettingsPath: shared, localPath: local }).args,
    ['--remote', 'unix://', 'resume', '--last']);
});

test('bridge: non-TUI subcommands, an explicit --remote, or no bot token stay untouched', () => {
  const { shared, local } = bridgeFixture('123:abc');
  for (const extraArgs of [['exec', 'hi'], ['app-server', 'daemon', 'version'], ['--remote', 'ws://h:1']]) {
    assert.deepEqual(buildCodexInvocation({ provider: null, extraArgs, envSettingsPath: shared, localPath: local }).args, extraArgs);
  }
  const none = bridgeFixture(null);
  assert.deepEqual(buildCodexInvocation({ provider: null, envSettingsPath: none.shared, localPath: none.local }).args, []);
});
