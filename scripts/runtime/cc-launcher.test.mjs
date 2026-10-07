// Unit tests for scripts/runtime/cc-launcher.mjs — the env + args projection
// that `cc.js` uses to spawn the `claude` binary.
//
// Single source of truth: one `providers.<name>` block per provider holds the
// URL + API key + per-host details exactly once. Local file paths are injected
// into a temp dir; the real ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildClaudeInvocation } from './cc-launcher.mjs';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';

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

test('cc.js deepseek projects url+claudePath → ANTHROPIC_BASE_URL, apiKey → claudeApiKeyEnv, models → per-class env vars', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: {
      deepseek: {
        url: 'https://api.deepseek.com',
        claudeApiKeyEnv: 'ANTHROPIC_API_KEY',
        claudePath: '/anthropic',
        models: {
          base: 'deepseek-v4-flash[1m]',
          fable: 'deepseek-v4-pro[1m]',
          opus: 'deepseek-v4-flash-vision-exp[1m]',
        },
      },
    },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-secret' } } }));
  const { env, error } = buildClaudeInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-secret');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-flash[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-flash-vision-exp[1m]');
  // sonnet/haiku/subagent fall back to `base` when not declared explicitly
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-flash[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash[1m]');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-flash[1m]');
});

test('cc.js gmi uses ANTHROPIC_AUTH_TOKEN (not ANTHROPIC_API_KEY) via claudeApiKeyEnv', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: {
      gmi: {
        url: 'https://api.gmi-serving.com',
        claudeApiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
        claudePath: '',
        models: { base: 'MiniMaxAI/MiniMax-M3[1m]' },
      },
    },
  }));
  writeFileSync(local, JSON.stringify({ providers: { gmi: { apiKey: 'gmi-secret' } } }));
  const { env, error } = buildClaudeInvocation({
    provider: 'gmi', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'gmi-secret');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'gmi must not set ANTHROPIC_API_KEY');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.gmi-serving.com');
});

test('cc.js missing shared file returns a clear error', () => {
  const { shared } = fixture();
  const { error } = buildClaudeInvocation({ provider: 'deepseek', envSettingsPath: shared });
  assert.match(error, /^Missing:/);
});

test('cc.js unknown provider returns an error listing available', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({ providers: { deepseek: {}, kimi: {} } }));
  const { error, available } = buildClaudeInvocation({
    provider: 'nope', envSettingsPath: shared, localPath: local,
  });
  assert.match(error, /^Unknown provider: nope/);
  assert.deepEqual(available, ['deepseek', 'kimi']);
  assert.match(error, /deepseek/);
});

test('cc.js local overlay merges apiKey over the shared providers block', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { deepseek: { url: 'https://api.deepseek.com', claudeApiKeyEnv: 'ANTHROPIC_API_KEY' } },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-only-in-local' } } }));
  const { env, error } = buildClaudeInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-only-in-local');
});

test('cc.js provider with no claudeExtras still works (extras map is optional)', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { minimal: { url: 'https://x.test', claudeApiKeyEnv: 'ANTHROPIC_API_KEY', models: { base: 'm' } } },
  }));
  writeFileSync(local, JSON.stringify({ providers: { minimal: { apiKey: 'k' } } }));
  const { env, error } = buildClaudeInvocation({
    provider: 'minimal', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://x.test');
  assert.equal(env.ANTHROPIC_MODEL, 'm');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
});

test('cc.js returns an error when claudeApiKeyEnv is declared but apiKey is missing', () => {
  // No apiKey in the local file — the launchers must surface a clear config error
  // rather than spawning claude without a key and letting the user get a 401.
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { deepseek: { url: 'https://api.deepseek.com', claudeApiKeyEnv: 'ANTHROPIC_API_KEY' } },
  }));
  writeFileSync(local, JSON.stringify({ providers: {} }));
  const { env, error } = buildClaudeInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.match(error, /no apiKey/);
  assert.match(error, /providers\.deepseek\.apiKey/);
  // The error path must NOT leak ANTHROPIC_API_KEY into the env (it was never set)
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('cc.js provider without claudeApiKeyEnv does not require an apiKey', () => {
  // A provider that has no API-key env var (e.g. an internal proxy that auths
  // upstream) shouldn't fail just because apiKey is empty.
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { proxy: { url: 'https://proxy.test', claudePath: '', models: { base: 'm' } } },
  }));
  writeFileSync(local, JSON.stringify({}));
  const { env, error } = buildClaudeInvocation({
    provider: 'proxy', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_MODEL, 'm');
});

test('cc.js extraArgs pass through unchanged', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { deepseek: { url: 'https://api.deepseek.com', claudeApiKeyEnv: 'ANTHROPIC_API_KEY' } },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'k' } } }));
  const { args } = buildClaudeInvocation({
    provider: 'deepseek', extraArgs: ['-r', 'find . -name "*.ts"'], envSettingsPath: shared, localPath: local,
  });
  assert.equal(args[args.length - 2], '-r');
  assert.equal(args[args.length - 1], 'find . -name "*.ts"');
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
    providers: { deepseek: { url: 'https://api.deepseek.com' } },
    bridge: { fallbackChatId: -100, projects: {} },
  }));
  writeFileSync(f.local, JSON.stringify(botToken ? { bridge: { botToken } } : {}));
  return f;
}

test('bridge: a configured bot token loads the session-bridge channel on official Claude', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const { args } = buildClaudeInvocation({ provider: null, extraArgs: ['-c'], envSettingsPath: shared, localPath: local });
  assert.deepEqual(args, [...CHANNEL_ARGS, '-c']);
});

test('bridge: no bot token -> no channel flag', () => {
  const { shared, local } = bridgeFixture(null);
  const { args } = buildClaudeInvocation({ provider: null, envSettingsPath: shared, localPath: local });
  assert.deepEqual(args, []);
});

test('bridge: a third-party provider never gets the channel (channels need Anthropic auth)', () => {
  const { shared, local } = bridgeFixture('123:abc');
  const { args, error } = buildClaudeInvocation({ provider: 'deepseek', envSettingsPath: shared, localPath: local });
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
  const run = (o) => buildClaudeInvocation({ provider: null, envSettingsPath: shared, localPath: local, machine: null, home, ...o });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude-other');
  try {
    assert.equal(run({ seat: 'team-b' }).env.CLAUDE_CONFIG_DIR, join(home, '.claude-team-b'));
    assert.equal(run({}).env.CLAUDE_CONFIG_DIR, undefined, 'an inherited seat never leaks into plain ccc');
    assert.match(run({ seat: 'team-a' }).error, /no seat dir .*run setup/);
    assert.match(run({ seat: '../x' }).error, /invalid seat alias/);
    assert.match(run({ seat: 'team-b', provider: 'deepseek' }).error, /subscription login/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
