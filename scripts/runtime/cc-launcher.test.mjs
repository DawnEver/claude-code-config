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
  const { shared } = fixture();
  writeFileSync(shared, '{}');
  const before = { ...process.env };
  const { env, args, provider: used, error } = buildClaudeInvocation({
    provider: null, extraArgs: ['--foo'], envSettingsPath: shared,
  });
  assert.equal(error, null);
  assert.equal(used, null);
  assert.deepEqual(args, ['--foo']);
  for (const k of PROVIDER_KEYS) {
    if (before[k] != null) assert.equal(env[k], undefined, `${k} should be stripped from parent env`);
  }
});

test('cc.js deepseek projects url+claudePath → ANTHROPIC_BASE_URL, apiKey → claudeApiKeyEnv, claudeExtras merged', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: {
      deepseek: {
        url: 'https://api.deepseek.com',
        claudeApiKeyEnv: 'ANTHROPIC_API_KEY',
        claudePath: '/anthropic',
        claudeModel: 'deepseek-v4-flash[1m]',
        claudeExtras: {
          ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro[1m]',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash[1m]',
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
        claudeModel: 'MiniMaxAI/MiniMax-M3[1m]',
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
    providers: { minimal: { url: 'https://x.test', claudeApiKeyEnv: 'ANTHROPIC_API_KEY', claudeModel: 'm' } },
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
    providers: { proxy: { url: 'https://proxy.test', claudePath: '', claudeModel: 'm' } },
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
