// Unit tests for scripts/setup/inject-codex-providers.mjs.
//
// Generates [model_providers.*] blocks for codex_config.toml from
// `claude_env_settings.json`. Each test uses mkdtempSync for temp files; the
// real ~/.codex is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateModelProvidersBlock,
  injectModelProviders,
  generateModelsJson,
  injectModelsJson,
  codexModelFrom,
  regenerateCodexArtifacts,
  codexSuffixIsEmpty,
  CODEX_TOML_START_MARKER,
  CODEX_TOML_END_MARKER,
} from './inject-codex-providers.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'inject-codex-'));
  return {
    path: join(dir, 'codex_config.toml'),
    modelsPath: join(dir, 'models.json'),
    settingsPath: join(dir, 'claude_env_settings.json'),
  };
}

const SHARED_DEEPSEEK_ONLY = {
  providers: {
    deepseek: {
      url: 'https://api.deepseek.com',
      codexApiKeyEnv: 'DEEPSEEK_API_KEY',
      codexPath: '/v1',
      models: { base: 'deepseek-v4-flash[1m]' },
    },
  },
};

const SHARED_DEEPSEEK_AND_GMI = {
  providers: {
    deepseek: {
      url: 'https://api.deepseek.com',
      codexApiKeyEnv: 'DEEPSEEK_API_KEY',
      codexPath: '/v1',
      models: { base: 'deepseek-v4-flash[1m]' },
    },
    gmi: {
      url: 'https://api.gmi-serving.com',
      codexApiKeyEnv: 'GMI_API_KEY',
      codexPath: '/v1',
      models: { base: 'MiniMaxAI/MiniMax-M3[1m]' },
    },
  },
};

test('generate: emits a [model_providers.*] block per provider with codexPath', () => {
  const out = generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY);
  assert.match(out, /\[model_providers\.deepseek\]/);
  assert.match(out, /name = "deepseek"/);
  assert.match(out, /base_url = "https:\/\/api\.deepseek\.com\/v1"/);
  assert.match(out, /env_key = "DEEPSEEK_API_KEY"/);
  assert.match(out, /wire_api = "responses"/);
  // model_catalog_json is applied per-provider by the cods launcher, NOT
  // globally, so plain `codex` keeps OpenAI's built-in model list.
  assert.doesNotMatch(out, /model_catalog_json\s*=/);
  assert.match(out, new RegExp(CODEX_TOML_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, new RegExp(CODEX_TOML_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('generate: composes url + codexPath into base_url', () => {
  const out = generateModelProvidersBlock({
    providers: {
      kimi: { url: 'https://api.kimi.com', codexApiKeyEnv: 'KIMI_API_KEY', codexPath: '/coding/v1' },
    },
  });
  assert.match(out, /base_url = "https:\/\/api\.kimi\.com\/coding\/v1"/);
});

test('generate: skips providers without codexPath (claude-only providers)', () => {
  const out = generateModelProvidersBlock({
    providers: {
      deepseek: { url: 'https://x.com', codexApiKeyEnv: 'D', codexPath: '/v1' },
      claudeOnly: { url: 'https://y.com', claudeApiKeyEnv: 'Y' /* no codexPath */ },
    },
  });
  assert.match(out, /\[model_providers\.deepseek\]/);
  assert.doesNotMatch(out, /\[model_providers\.claudeOnly\]/);
});

test('generate: returns empty string when no provider has codexPath', () => {
  const out = generateModelProvidersBlock({ providers: { only: { url: 'https://x.com' } } });
  assert.equal(out, '');
});

test('inject: appends a new managed section when the file has no markers', () => {
  const { path } = fixture();
  writeFileSync(path, 'model = "gpt-5.6-sol"\nsandbox_mode = "danger-full-access"\n');
  const generated = generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY);
  const result = injectModelProviders(path, generated);
  assert.equal(result.status, 'updated');
  assert.equal(result.providers, 1);
  const after = readFileSync(path, 'utf8');
  // User's pre-existing content is preserved ABOVE the markers
  assert.match(after, /model = "gpt-5\.6-sol"/);
  assert.match(after, /\[model_providers\.deepseek\]/);
});

test('inject: replaces the existing managed section in place (idempotent)', () => {
  const { path } = fixture();
  const initial = `model = "gpt-5.6-sol"\n\n${CODEX_TOML_START_MARKER}\n[model_providers.deepseek]\nbase_url = "STALE"\nenv_key = "STALE"\nwire_api = "responses"\n${CODEX_TOML_END_MARKER}\n`;
  writeFileSync(path, initial);
  const generated = generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY);
  const result = injectModelProviders(path, generated);
  assert.equal(result.status, 'updated');
  const after = readFileSync(path, 'utf8');
  assert.match(after, /model = "gpt-5\.6-sol"/);
  assert.match(after, /base_url = "https:\/\/api\.deepseek\.com\/v1"/);
  assert.doesNotMatch(after, /STALE/);
});

test('inject: no-change when the generated section already matches', () => {
  const { path } = fixture();
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  // Inject once to populate the managed section
  const first = injectModelProviders(path, generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY));
  assert.equal(first.status, 'updated');
  const before = readFileSync(path, 'utf8');
  // Inject again — should be a no-change
  const second = injectModelProviders(path, generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY));
  assert.equal(second.status, 'no-change');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('inject: returns no-config when the file does not exist', () => {
  const { path } = fixture();
  const result = injectModelProviders(path, generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY));
  assert.equal(result.status, 'no-config');
  assert.equal(existsSync(path), false);
});

test('inject: returns empty when no provider has a codex-side declaration', () => {
  const { path } = fixture();
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  const generated = generateModelProvidersBlock({ providers: { claudeOnly: { url: 'https://x.com' } } });
  const result = injectModelProviders(path, generated);
  assert.equal(result.status, 'empty');
  // The user's file is not modified
  assert.equal(readFileSync(path, 'utf8'), 'model = "gpt-5.6-sol"\n');
});

test('inject: regenerates when providers change (add deepseek + gmi)', () => {
  const { path } = fixture();
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  // First injection: deepseek only
  const first = injectModelProviders(path, generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY));
  assert.equal(first.status, 'updated');
  // Second injection: add gmi — managed section is replaced in place
  const result = injectModelProviders(path, generateModelProvidersBlock(SHARED_DEEPSEEK_AND_GMI));
  assert.equal(result.status, 'updated');
  assert.equal(result.providers, 2);
  const after = readFileSync(path, 'utf8');
  assert.match(after, /\[model_providers\.deepseek\]/);
  assert.match(after, /name = "deepseek"/);
  assert.match(after, /\[model_providers\.gmi\]/);
  assert.match(after, /name = "gmi"/);
});

test('inject: handles a malformed existing block (start marker without end) by replacing to EOF', () => {
  const { path } = fixture();
  const initial = `model = "gpt-5.6-sol"\n\n${CODEX_TOML_START_MARKER}\n[model_providers.stale]\nbase_url = "STALE"\n`;
  writeFileSync(path, initial);
  const result = injectModelProviders(path, generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY));
  assert.equal(result.status, 'updated');
  const after = readFileSync(path, 'utf8');
  assert.doesNotMatch(after, /STALE/);
  assert.match(after, /\[model_providers\.deepseek\]/);
  assert.match(after, new RegExp(CODEX_TOML_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('codexModelFrom: strips the [1m] context suffix and honors an explicit codex key', () => {
  assert.equal(codexModelFrom({ base: 'deepseek-v4-flash[1m]' }), 'deepseek-v4-flash');
  assert.equal(codexModelFrom({ base: 'MiniMaxAI/MiniMax-M3[1m]' }), 'MiniMaxAI/MiniMax-M3');
  assert.equal(codexModelFrom({ base: 'k3[1m]', codex: 'kimi-for-coding' }), 'kimi-for-coding');
  assert.equal(codexModelFrom({}), '');
});

test('generateModelsJson: catalogs every distinct role model with the full schema', () => {
  const out = generateModelsJson({
    providers: {
      deepseek: {
        models: {
          base: 'deepseek-v4-flash[1m]',
          fable: 'deepseek-v4-pro[1m]',
          opus: 'deepseek-v4-flash-vision-exp[1m]',
        },
      },
    },
  });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.models));
  // base/fable/opus → flash, pro, vision all appear in the picker
  assert.deepEqual(parsed.models.map(m => m.slug).sort(), [
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro',
  ]);
  const flash = parsed.models.find(m => m.slug === 'deepseek-v4-flash');
  // Schema-complete fields Codex needs to accept the catalog
  assert.equal(flash.context_window, 1048576);
  assert.equal(flash.max_context_window, 1048576);
  assert.equal(flash.visibility, 'list');
  assert.equal(flash.minimal_client_version, '0.144.0');
  assert.equal(flash.default_reasoning_level, 'high');
  assert.ok(flash.supported_reasoning_levels.some(r => r.effort === 'max'));
  assert.deepEqual(flash.truncation_policy, { mode: 'tokens', limit: 10000 });
  assert.equal(flash.supports_parallel_tool_calls, true);
});

test('generateModelsJson: a vision role model catalogs image input', () => {
  const out = generateModelsJson({
    providers: { deepseek: { models: { base: 'deepseek-v4-flash-vision-exp[1m]' } } },
  });
  const [entry] = JSON.parse(out).models;
  assert.deepEqual(entry.input_modalities, ['text', 'image']);
  assert.equal(entry.supports_image_detail_original, true);
});

test('generateModelsJson: unknown model gets a generic, schema-complete entry', () => {
  const out = generateModelsJson({
    providers: { gmi: { models: { base: 'MiniMaxAI/MiniMax-M3[1m]' } } },
  });
  const [entry] = JSON.parse(out).models;
  assert.equal(entry.slug, 'MiniMaxAI/MiniMax-M3');
  assert.deepEqual(entry.input_modalities, ['text']);
  assert.equal(entry.visibility, 'list');
  assert.equal(typeof entry.context_window, 'number');
  assert.equal(entry.supports_image_detail_original, false);
});

test('generateModelsJson: dedupes models shared across providers', () => {
  const out = generateModelsJson({
    providers: {
      a: { models: { base: 'shared[1m]' } },
      b: { models: { base: 'shared[1m]', fable: 'other' } },
    },
  });
  assert.equal(JSON.parse(out).models.length, 2); // shared + other
});

test('generateModelsJson: returns empty when no provider has a codex model', () => {
  assert.equal(generateModelsJson({ providers: { claudeOnly: { url: 'https://x.com' } } }), '');
});

test('injectModelsJson: writes, then no-ops on re-injection (idempotent)', () => {
  const { modelsPath } = fixture();
  const generated = generateModelsJson(SHARED_DEEPSEEK_AND_GMI);
  const first = injectModelsJson(modelsPath, generated);
  assert.equal(first.status, 'updated');
  assert.equal(first.models, 2);
  const second = injectModelsJson(modelsPath, generated);
  assert.equal(second.status, 'no-change');
  assert.equal(readFileSync(modelsPath, 'utf8'), generated);
});

test('injectModelsJson: returns empty when there is nothing to catalog', () => {
  const { modelsPath } = fixture();
  assert.equal(injectModelsJson(modelsPath, '').status, 'empty');
  assert.equal(existsSync(modelsPath), false);
});

// --- regenerateCodexArtifacts (SR-001: models.json is independent of codex_config.toml) ---

test('regenerate: writes models.json even when codex_config.toml is absent', () => {
  const { path, modelsPath, settingsPath } = fixture();
  writeFileSync(settingsPath, JSON.stringify(SHARED_DEEPSEEK_ONLY));
  const r = regenerateCodexArtifacts({ settingsPath, codexConfigPath: path, modelsPath });
  assert.equal(r.settings, 'ok');
  assert.equal(r.providers.status, 'no-config');
  assert.equal(r.models.status, 'updated');
  assert.equal(existsSync(path), false); // regeneration never creates the config
  assert.equal(existsSync(modelsPath), true);
  assert.deepEqual(JSON.parse(readFileSync(modelsPath, 'utf8')).models.map(m => m.slug), ['deepseek-v4-flash']);
});

test('regenerate: injects providers when codex_config.toml is present and also writes models.json', () => {
  const { path, modelsPath, settingsPath } = fixture();
  writeFileSync(settingsPath, JSON.stringify(SHARED_DEEPSEEK_ONLY));
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  const r = regenerateCodexArtifacts({ settingsPath, codexConfigPath: path, modelsPath });
  assert.equal(r.settings, 'ok');
  assert.equal(r.providers.status, 'updated');
  assert.equal(r.providers.providers, 1);
  assert.match(readFileSync(path, 'utf8'), /\[model_providers\.deepseek\]/);
  assert.equal(r.models.status, 'updated');
  assert.equal(existsSync(modelsPath), true);
});

test('regenerate: idempotent — second call is a no-change and rewrites nothing', () => {
  const { path, modelsPath, settingsPath } = fixture();
  writeFileSync(settingsPath, JSON.stringify(SHARED_DEEPSEEK_AND_GMI));
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  const first = regenerateCodexArtifacts({ settingsPath, codexConfigPath: path, modelsPath });
  assert.equal(first.providers.status, 'updated');
  assert.equal(first.models.status, 'updated');
  const cfgBefore = readFileSync(path, 'utf8');
  const modelsBefore = readFileSync(modelsPath, 'utf8');
  const second = regenerateCodexArtifacts({ settingsPath, codexConfigPath: path, modelsPath });
  assert.equal(second.providers.status, 'no-change');
  assert.equal(second.models.status, 'no-change');
  assert.equal(readFileSync(path, 'utf8'), cfgBefore);
  assert.equal(readFileSync(modelsPath, 'utf8'), modelsBefore);
});

test('regenerate: missing settings returns missing and writes nothing', () => {
  const { path, modelsPath, settingsPath } = fixture();
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  const cfgBefore = readFileSync(path, 'utf8');
  const r = regenerateCodexArtifacts({ settingsPath, codexConfigPath: path, modelsPath });
  assert.equal(r.settings, 'missing');
  assert.equal(r.models.status, 'empty');
  assert.equal(r.providers.status, 'empty');
  assert.equal(existsSync(modelsPath), false);
  assert.equal(readFileSync(path, 'utf8'), cfgBefore); // last-known-good config preserved
});

test('regenerate: unparseable settings returns unparseable with an error and writes nothing', () => {
  const { path, modelsPath, settingsPath } = fixture();
  writeFileSync(settingsPath, '{ this is not json');
  writeFileSync(path, 'model = "gpt-5.6-sol"\n');
  const cfgBefore = readFileSync(path, 'utf8');
  const r = regenerateCodexArtifacts({ settingsPath, codexConfigPath: path, modelsPath });
  assert.equal(r.settings, 'unparseable');
  assert.ok(r.error instanceof Error);
  assert.equal(existsSync(modelsPath), false);
  assert.equal(readFileSync(path, 'utf8'), cfgBefore);
});

// --- SR-003: the no-marker/append branch must be treated as suffix-empty ---

test('codexSuffixIsEmpty: no-marker append branch is suffix-empty explicitly (SR-003)', () => {
  // A long no-marker file: the old `slice(-1 + END.length)` would land mid-file
  // and read as non-empty.
  const longNoMarker = 'model = "gpt-5.6-sol"\n'.repeat(10);
  assert.equal(codexSuffixIsEmpty(longNoMarker, -1), true);
  // Markers present: the suffix is whatever follows the END marker.
  assert.equal(codexSuffixIsEmpty('abc' + CODEX_TOML_END_MARKER, 3), true);
  assert.equal(codexSuffixIsEmpty('abc' + CODEX_TOML_END_MARKER + '\n', 3), false);
  assert.equal(codexSuffixIsEmpty('abc' + CODEX_TOML_END_MARKER + '\nsection', 3), false);
});

test('inject: no-marker append is byte-stable across two injections with exactly one trailing newline', () => {
  const { path } = fixture();
  // No markers, and longer than the END marker so a mid-file slice would be non-empty.
  writeFileSync(path, 'model = "gpt-5.6-sol"\n'.repeat(10));
  const generated = generateModelProvidersBlock(SHARED_DEEPSEEK_ONLY);
  const first = injectModelProviders(path, generated);
  assert.equal(first.status, 'updated');
  const afterFirst = readFileSync(path, 'utf8');
  assert.match(afterFirst, /[^\n]\n$/); // exactly one trailing newline
  const second = injectModelProviders(path, generated);
  assert.equal(second.status, 'no-change');
  assert.equal(readFileSync(path, 'utf8'), afterFirst);
});
