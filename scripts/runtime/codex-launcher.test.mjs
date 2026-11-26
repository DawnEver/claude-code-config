// Unit tests for scripts/runtime/codex-launcher.mjs — the env + CLI-flag
// projection that `codex.js` uses to spawn the `codex` binary.
//
// The codex projection differs from the claude one: `--config model_provider=<name>`
// selects the block setup composes, `--model <name>` (no env var exists), and the key goes
// into the projection rule's env var. The catalogue and the key are injected; the real
// ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildCodexInvocation, startCodexDaemon } from './codex-launcher.mjs';
import { readProviderCache } from '../shared/provider-cache.mjs';
import { fakeAiLab, writeCache } from '../shared/provider-cache-fixture.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// Provider launches scope the codex model catalog to the absolute
// ~/.codex/models.json (global config would leak 3rd-party models into plain
// `codex`). Computed the same way the launcher does so the assertion is robust.
const CATALOG_FLAG = `model_catalog_json=${join(homedir(), '.codex', 'models.json')}`;

const CODEX_STRIP_KEYS = [
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'CODEX_NON_INTERACTIVE', 'CODEX_CA_CERTIFICATE',
];

function fixture() {
  const dir = tempDir('codex-launcher-');
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

test('explicit Codex home reaches vendor process and scopes its provider model catalogue', () => {
  const customHome = join(tempDir('codex-custom-'), 'codex-custom-home');
  const { env, args } = invoke(RULES, {}, { baseEnv: { CODEX_HOME: customHome } });
  assert.equal(env.CODEX_HOME, customHome);
  assert.ok(args.includes(`model_catalog_json=${join(customHome, 'models.json')}`));
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

// ── session bridge: the TUI must attach to the shared app-server (docs/bridge.md) ──

function bridgeFixture(botToken) {
  const dir = tempDir('codex-bridge-');
  const shared = join(dir, 'claude_env_settings.json');
  const local = join(dir, 'claude_env_settings.local.json');
  writeFileSync(shared, JSON.stringify({ providers: { deepseek: { codexApiKeyEnv: 'DEEPSEEK_API_KEY' } } }));
  writeFileSync(local, JSON.stringify(botToken ? { bridge: { botToken } } : {}));
  return { shared, local };
}

// The shared daemon, as the launcher asks Codex to start it: each call is recorded; null is "running".
function daemonStub(error = null) {
  const calls = [];
  return { calls, startDaemon: (opts) => { calls.push(opts); return error; } };
}

test('bridge: interactive official TUI starts the shared daemon, then attaches to it', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const d = daemonStub();
  const baseEnv = { PATH: '/bin' };
  const plain = buildCodexInvocation({ provider: null, envSettingsPath: shared, localPath: local, baseEnv, startDaemon: d.startDaemon });
  assert.deepEqual(plain.args, ['--remote', 'unix://']);
  assert.equal(plain.notice, null);
  assert.equal(d.calls.length, 1, 'the daemon is started (or found running) before the TUI attaches');
  assert.equal(d.calls[0].env.CODEX_HOME, plain.env.CODEX_HOME, 'in the Codex home the TUI attaches to');
  assert.deepEqual(buildCodexInvocation({ provider: null, extraArgs: ['fix the build'], envSettingsPath: shared, localPath: local, startDaemon: d.startDaemon }).args,
    ['--remote', 'unix://', 'fix the build']);
  const codexHome = tempDir('codex-home-');  // no rollout: `--last` stays for the TUI to pick
  assert.deepEqual(buildCodexInvocation({ provider: null, extraArgs: ['resume', '--last'], envSettingsPath: shared, localPath: local, codexHome, startDaemon: d.startDaemon }).args,
    ['--remote', 'unix://', 'resume', '--last']);
});

test('bridge: a daemon that will not start leaves the TUI on its own server, and says why', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const d = daemonStub('connection refused (os error 10061)');
  const r = buildCodexInvocation({ provider: null, extraArgs: ['fix the build'], envSettingsPath: shared, localPath: local, startDaemon: d.startDaemon });
  assert.deepEqual(r.args, ['fix the build'], 'no --remote to a daemon that is not there');
  assert.equal(r.error, null, 'the launch goes on');
  assert.match(r.notice, /connection refused \(os error 10061\)/, 'the cause');
  assert.match(r.notice, /outside the session bridge/, 'what it costs');
  assert.match(r.notice, /codex app-server daemon start/, 'the door');
});

test('bridge: non-TUI subcommands, an explicit --remote, or no bot token stay untouched and start nothing', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const d = daemonStub();
  for (const extraArgs of [['exec', 'hi'], ['app-server', 'daemon', 'version'], ['--remote', 'ws://h:1'], ['--no-daemon'], ['--no-daemon', 'resume', '--last'], ['--model', 'x', 'exec', 'hi']]) {
    assert.deepEqual(buildCodexInvocation({ provider: null, extraArgs, envSettingsPath: shared, localPath: local, startDaemon: d.startDaemon }).args, extraArgs);
  }
  const none = bridgeFixture(null);
  assert.deepEqual(buildCodexInvocation({ provider: null, envSettingsPath: none.shared, localPath: none.local, startDaemon: d.startDaemon }).args, []);
  assert.equal(d.calls.length, 0, 'only an attaching TUI needs the daemon');
});

test('startCodexDaemon reads the status Codex prints last; anything but started or alreadyRunning is the cause', () => {
  const status = (s) => () => `{"timestampMs":1,"stage":"pid_write"}\n{"status":"${s}","pid":7}\n`;
  assert.equal(startCodexDaemon({ run: status('started') }), null);
  assert.equal(startCodexDaemon({ run: status('alreadyRunning') }), null);
  assert.match(startCodexDaemon({ run: status('stopped') }), /stopped/);
  assert.match(startCodexDaemon({ run: () => 'not json' }), /no status/);
  assert.match(startCodexDaemon({ run: () => { throw new Error('spawn codex ENOENT\nmore'); } }), /^spawn codex ENOENT$/);
  let seen;
  startCodexDaemon({ env: { CODEX_HOME: '/h' }, run: (cmd, args, opts) => { seen = { cmd, args, opts }; return '{"status":"started"}'; } });
  assert.deepEqual([seen.cmd, ...seen.args].join(' ').split(' ').slice(-4), ['codex', 'app-server', 'daemon', 'start'].slice(-4));
  assert.equal(seen.opts.env.CODEX_HOME, '/h');
  assert.ok(seen.opts.timeout > 0, 'a hung start cannot hold the launch');
});
