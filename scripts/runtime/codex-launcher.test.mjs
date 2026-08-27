// Unit tests for scripts/runtime/codex-launcher.mjs — the env + CLI-flag
// projection that `codex.js` uses to spawn the `codex` binary.
//
// Single source of truth: same `providers.<name>` block as `cc.js`. The codex
// projection differs from the claude one: codex needs `--config openai_base_url=…`
// (not `OPENAI_BASE_URL` env — silently ignored in v0.118+, see
// openai/codex#16719), `--model <name>` (no env var exists), and the API key
// env-var name is the literal `env_key` configured in `codex_config.toml`'s
// `model_providers.<id>` block. Local file paths are injected into a temp dir;
// the real ~/.claude is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildCodexInvocation } from './codex-launcher.mjs';

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
  const { shared } = fixture();
  writeFileSync(shared, '{}');
  const before = { ...process.env };
  const { env, args, provider: used, error } = buildCodexInvocation({
    provider: null, extraArgs: ['--foo'], envSettingsPath: shared,
  });
  assert.equal(error, null);
  assert.equal(used, null);
  assert.deepEqual(args, ['--foo']);
  for (const k of CODEX_STRIP_KEYS) {
    if (before[k] != null) assert.equal(env[k], undefined, `${k} should be stripped from parent env`);
  }
});

test('codex.js deepseek derives --model from models.base (strips [1m])', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: {
      deepseek: {
        url: 'https://api.deepseek.com',
        codexApiKeyEnv: 'DEEPSEEK_API_KEY',
        codexPath: '/v1',
        models: { base: 'deepseek-v4-flash[1m]' },
      },
    },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-secret' } } }));
  const { env, args, error } = buildCodexInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-secret');
  // Must not leak Claude-side env vars
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  // Args order: --config model_provider=<name> (selects the provider's
  // [model_providers.*] block from config.toml), --model <model>. The [1m]
  // context-window suffix is Claude-side; codex gets the bare model id.
  assert.deepEqual(args, [
    '--config', 'model_provider=deepseek',
    '--config', CATALOG_FLAG,
    '--model', 'deepseek-v4-flash',
  ]);
});

test('codex.js models.codex override wins over the base derivation', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: {
      deepseek: {
        url: 'https://api.deepseek.com',
        codexApiKeyEnv: 'DEEPSEEK_API_KEY',
        codexPath: '/v1',
        models: { base: 'deepseek-v4-flash[1m]', codex: 'deepseek-v4-pro' },
      },
    },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-secret' } } }));
  const { args, error } = buildCodexInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(args[args.length - 1], 'deepseek-v4-pro');
});

test('codex.js gmi uses ANTHROPIC_AUTH_TOKEN via codexApiKeyEnv and the M3 model', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: {
      gmi: {
        url: 'https://api.gmi-serving.com',
        codexApiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
        codexPath: '/v1',
        models: { base: 'MiniMaxAI/MiniMax-M3[1m]' },
      },
    },
  }));
  writeFileSync(local, JSON.stringify({ providers: { gmi: { apiKey: 'gmi-secret' } } }));
  const { env, args, error } = buildCodexInvocation({
    provider: 'gmi', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'gmi-secret');
  assert.deepEqual(args, [
    '--config', 'model_provider=gmi',
    '--config', CATALOG_FLAG,
    '--model', 'MiniMaxAI/MiniMax-M3',
  ]);
});

test('codex.js extraArgs are appended after launcher-injected flags', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { deepseek: { url: 'https://api.deepseek.com', codexApiKeyEnv: 'K', codexPath: '/v1', models: { base: 'm' } } },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'k' } } }));
  const { args } = buildCodexInvocation({
    provider: 'deepseek', extraArgs: ['-q', 'hello'],
    envSettingsPath: shared, localPath: local,
  });
  assert.equal(args[args.length - 2], '-q');
  assert.equal(args[args.length - 1], 'hello');
  // Launcher-injected flags come first
  assert.equal(args[0], '--config');
  assert.equal(args[4], '--model');
});

test('codex.js missing shared file returns a clear error', () => {
  const { shared } = fixture();
  const { error } = buildCodexInvocation({ provider: 'deepseek', envSettingsPath: shared });
  assert.match(error, /^Missing:/);
});

test('codex.js unknown provider returns an error listing available', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({ providers: { deepseek: {}, gmi: {} } }));
  const { error, available } = buildCodexInvocation({
    provider: 'nope', envSettingsPath: shared, localPath: local,
  });
  assert.match(error, /^Unknown codex provider: nope/);
  assert.deepEqual(available, ['deepseek', 'gmi']);
});

test('codex.js selects the provider even with no models (emits model_provider but no --model)', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { minimal: { codexApiKeyEnv: 'K' } },
  }));
  writeFileSync(local, JSON.stringify({ providers: { minimal: { apiKey: 'k' } } }));
  const { args, env, error } = buildCodexInvocation({
    provider: 'minimal', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.K, 'k');
  // Always select the provider's [model_providers.minimal] block; --model only
  // when the provider declares a models map.
  assert.deepEqual(args, ['--config', 'model_provider=minimal', '--config', CATALOG_FLAG]);
  assert.equal(args.includes('--model'), false);
});

test('codex.js local overlay merges apiKey over the shared providers block', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { deepseek: { url: 'https://api.deepseek.com', codexApiKeyEnv: 'DEEPSEEK_API_KEY', models: { base: 'deepseek-v4-flash' } } },
  }));
  writeFileSync(local, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-only-in-local' } } }));
  const { env, error } = buildCodexInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.equal(error, null);
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-only-in-local');
});

test('codex.js returns an error when codexApiKeyEnv is declared but apiKey is missing', () => {
  const { shared, local } = fixture();
  writeFileSync(shared, JSON.stringify({
    providers: { deepseek: { url: 'https://api.deepseek.com', codexApiKeyEnv: 'DEEPSEEK_API_KEY' } },
  }));
  writeFileSync(local, JSON.stringify({ providers: {} }));
  const { env, error } = buildCodexInvocation({
    provider: 'deepseek', envSettingsPath: shared, localPath: local,
  });
  assert.match(error, /no apiKey/);
  assert.match(error, /providers\.deepseek\.apiKey/);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
});
