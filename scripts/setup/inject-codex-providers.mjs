// scripts/setup/inject-codex-providers.mjs — derive [model_providers.*] blocks
// for `codex_config.toml` from the shared `claude_env_settings.json` `providers`
// registry.
//
// Without this, every fresh install of `cods` / `cogmi` fails with "model
// provider not found in config.toml" because `codex_config.template.toml`
// ships no `[model_providers.*]` blocks. The user's registry already holds
// the URL, codex-side path, and codexApiKeyEnv per provider — the missing
// piece is just emitting those as the TOML block codex expects.
//
// The generated section lives between two setup-managed markers so:
// - Setup can replace only the generated content on subsequent runs (idempotent)
// - User edits ABOVE the markers (their own custom TOML) are preserved verbatim
// - User edits INSIDE the generated block are overwritten by the next setup run
//   (intentional — they should edit `claude_env_settings.json` to customize)

import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The repo's single-source codex prompt. Codex 0.149 REQUIRES every models.json
// entry to carry `base_instructions` (or `model_messages.instructions_template`);
// we embed the repo's own prompt here (NOT DeepSeek's embedded "You are Codex,
// based on GPT-5") so codex accepts the catalog AND the prompt stays the repo's
// `codex-base.md`. This is the one source — models.json derives from it.
const CODEX_BASE_PROMPT_PATH = join(__dirname, '..', '..', 'system-prompt', 'codex-base.md');
let _codexBasePrompt;
function codexBasePrompt() {
  if (_codexBasePrompt === undefined) {
    _codexBasePrompt = fs.existsSync(CODEX_BASE_PROMPT_PATH)
      ? fs.readFileSync(CODEX_BASE_PROMPT_PATH, 'utf8').trim()
      : '';
  }
  return _codexBasePrompt;
}

export const CODEX_TOML_START_MARKER = '# === setup-managed: model_providers (do not edit below this line) ===';
export const CODEX_TOML_END_MARKER = '# === setup-managed: model_providers end ===';

/**
 * Whether the content after the END marker is empty. In the no-marker/append
 * branch (`endIdx === -1`) treat the suffix as empty explicitly — indexing the
 * string at `-1 + END.length` would land mid-file and make the comparison
 * meaningless (SR-003).
 */
export function codexSuffixIsEmpty(existing, endIdx) {
  return endIdx === -1
    ? true
    : existing.slice(endIdx + CODEX_TOML_END_MARKER.length) === '';
}

// Per-model capability catalog for the generated `~/.codex/models.json`, keyed by
// the BARE codex model id (e.g. `deepseek-v4-flash` — the `[1m]` suffix is a
// Claude-side context-window request). Each cataloged model is a candidate in the
// codex `--model` picker; capability metadata (context window, reasoning levels,
// image input) comes from here, or a GENERIC fallback for unknown models.
//
// Emitted entries follow Codex's full model schema (mirrored from the DeepSeek
// docs' `models.json`). `base_instructions` is set to the repo's OWN codex prompt
// (`system-prompt/codex-base.md`), not DeepSeek's embedded "You are Codex, based on
// GPT-5" — codex 0.149 requires the field, and this keeps the prompt the repo's.
// `model_messages` is omitted (base_instructions suffices).
const MODEL_CATALOG = {
  'deepseek-v4-flash': {
    display_name: 'DeepSeek-V4-Flash',
    description: 'Latest frontier agentic coding model.',
    context_window: 1048576,
    input_modalities: ['text'],
    priority: 1,
  },
  'deepseek-v4-pro': {
    display_name: 'DeepSeek-V4-Pro',
    description: 'Most capable frontier agentic coding model.',
    context_window: 1048576,
    input_modalities: ['text'],
    priority: 2,
  },
  'deepseek-v4-flash-vision-exp': {
    display_name: 'DeepSeek-V4-Flash-Vision',
    description: 'Latest frontier agentic coding model with image input.',
    context_window: 1048576,
    input_modalities: ['text', 'image'],
    supports_image_detail_original: true,
    priority: 3,
  },
};

// Codex model-schema fields identical across all our providers/models. Per-model
// fields (slug, display_name, description, context_window, input_modalities,
// priority, supports_image_detail_original) are merged over this in `modelEntry()`.
// Mirrors the DeepSeek docs' models.json defaults so Codex accepts the catalog
// instead of falling back to its built-in OpenAI model list.
const MODEL_TEMPLATE = {
  prefer_websockets: false,
  support_verbosity: true,
  default_verbosity: 'low',
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text',
  supports_image_detail_original: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  tool_mode: null,
  multi_agent_version: 'v2',
  use_responses_lite: false,
  include_skills_usage_instructions: false,
  auto_review_model_override: null,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  comp_hash: '3000',
  reasoning_summary_format: 'experimental',
  default_reasoning_summary: 'none',
  default_reasoning_level: 'high',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
    { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  ],
  shell_type: 'shell_command',
  visibility: 'list',
  minimal_client_version: '0.144.0',
  supported_in_api: true,
  availability_nux: null,
  upgrade: null,
  experimental_supported_tools: [],
  supports_search_tool: true,
  default_service_tier: null,
  supports_reasoning_summaries: true,
};

/**
 * Derive the bare codex model id from a provider's `models` map (same rule as
 * codex-launcher.mjs: `models.codex` wins, else `models.base` with the `[1m]`
 * context-window suffix stripped).
 */
export function codexModelFrom(models) {
  if (models?.codex) return models.codex;
  return String(models?.base ?? '').replace(/\s*\[\s*\w+\s*\]\s*$/, '');
}

/**
 * Build the generated model_providers section from a parsed `claude_env_settings.json`
 * (the shared registry, NOT the machine-local overlay — `apiKey` is not needed
 * here, only the env-var name the provider block declares as `codexApiKeyEnv`).
 *
 * @param {object} settings  Parsed `claude_env_settings.json` (or any shape with `.providers`)
 * @returns {string}  The full generated block, including start/end markers. Empty
 *   string if no provider has a codex-side declaration (caller can choose to no-op).
 */
export function generateModelProvidersBlock(settings) {
  const providers = settings?.providers || {};
  const blocks = [];
  for (const [name, profile] of Object.entries(providers)) {
    if (!profile || typeof profile !== 'object') continue;
    if (!profile.url || !profile.codexPath) continue; // no codex-side surface
    const baseUrl = profile.url + (profile.codexPath ?? '');
    const envKey = profile.codexApiKeyEnv || 'API_KEY';
    blocks.push(`[model_providers.${name}]
name = "${name}"
base_url = "${baseUrl}"
env_key = "${envKey}"
wire_api = "responses"
`);
  }
  if (blocks.length === 0) return '';
  return `${CODEX_TOML_START_MARKER}
# Generated by scripts/setup/inject-codex-providers.mjs from claude_env_settings.json.
# Re-runs of setup.js regenerate this section from the shared registry. To customize,
# edit 'providers.<name>' in claude_env_settings.json (not this file).
# Point codex at the model catalog (models.json) so the --model picker lists the
# providers' models instead of falling back to the built-in OpenAI list.
model_catalog_json = "~/.codex/models.json"

${blocks.join('\n')}${CODEX_TOML_END_MARKER}
`;
}

/**
 * Write the generated section into `codex_config.toml`, replacing any prior
 * setup-managed block in place. Idempotent: a no-op when the generated content
 * already matches the file.
 *
 * @param {string} codexConfigPath  Path to `codex_config.toml` (synced file, not the template).
 * @param {string} generatedBlock   Output of `generateModelProvidersBlock`.
 * @returns {{ status: 'no-config' | 'no-change' | 'updated' | 'empty', providers?: number }}
 */
export function injectModelProviders(codexConfigPath, generatedBlock) {
  if (!fs.existsSync(codexConfigPath)) return { status: 'no-config' };
  if (!generatedBlock) return { status: 'empty' };

  const existing = fs.readFileSync(codexConfigPath, 'utf8');
  const startIdx = existing.indexOf(CODEX_TOML_START_MARKER);
  const endIdx = existing.indexOf(CODEX_TOML_END_MARKER);

  let next;
  if (startIdx !== -1 && endIdx !== -1) {
    next = existing.slice(0, startIdx) + generatedBlock + existing.slice(endIdx + CODEX_TOML_END_MARKER.length);
  } else if (startIdx !== -1) {
    // Malformed — start without end. Replace from start to EOF.
    next = existing.slice(0, startIdx) + generatedBlock;
  } else {
    next = existing.trimEnd() + '\n\n' + generatedBlock;
  }

  // Normalize trailing newline so the second-run "no-change" check compares
  // apples to apples regardless of which branch produced the file the first
  // time. If the post-marker suffix is non-empty, the user already has trailing
  // content; leave it alone. Otherwise guarantee exactly one trailing newline.
  if (codexSuffixIsEmpty(existing, endIdx)) {
    next = next.replace(/\n*$/, '') + '\n';
  } else {
    next = next.replace(/\n+$/, '\n');
  }

  if (next === existing) return { status: 'no-change' };
  fs.writeFileSync(codexConfigPath, next);
  return {
    status: 'updated',
    providers: (generatedBlock.match(/\[model_providers\./g) || []).length,
  };
}

// Role keys in a provider's `models` map that can each name a distinct model. The
// codex catalog exposes every distinct model across all roles (e.g. deepseek's
// base=flash, fable=pro, opus=vision → all three show in the picker), not just the
// base the `cods` launcher defaults to.
const MODEL_ROLE_KEYS = ['base', 'fable', 'opus', 'sonnet', 'haiku', 'subagent', 'codex'];

// Build one schema-complete codex model entry for a bare codex model id.
function modelEntry(codexId) {
  const meta = MODEL_CATALOG[codexId] ?? {
    display_name: codexId,
    description: '',
    context_window: 1000000,
    input_modalities: ['text'],
    priority: 0,
  };
  const inputModalities = meta.input_modalities ?? ['text'];
  return {
    slug: codexId,
    ...MODEL_TEMPLATE,
    input_modalities: inputModalities,
    supports_image_detail_original: !!meta.supports_image_detail_original,
    context_window: meta.context_window,
    max_context_window: meta.context_window,
    display_name: meta.display_name ?? codexId,
    description: meta.description ?? '',
    priority: meta.priority ?? 0,
    // Required by codex 0.149; carries the repo's own codex prompt (single source).
    base_instructions: codexBasePrompt(),
  };
}

/**
 * Build the full `~/.codex/models.json` catalog from the shared providers
 * registry — one schema-complete entry per distinct codex-facing model. Every
 * provider with a `models` map contributes its codex model ids (all roles,
 * deduplicated); capability metadata comes from `MODEL_CATALOG` (deepseek-v4
 * family) or a generic fallback (unknown models).
 *
 * @param {object} settings  Parsed `claude_env_settings.json`.
 * @returns {string}  JSON catalog string, or '' if no provider has a codex model.
 */
export function generateModelsJson(settings) {
  const providers = settings?.providers || {};
  const seen = new Set();
  const entries = [];
  for (const [name, profile] of Object.entries(providers)) {
    const models = profile?.models;
    if (!models || typeof models !== 'object') continue;
    for (const key of MODEL_ROLE_KEYS) {
      if (!models[key]) continue;
      const codexId = String(models[key]).replace(/\s*\[\s*\w+\s*\]\s*$/, '');
      if (!codexId || seen.has(codexId)) continue;
      seen.add(codexId);
      entries.push(modelEntry(codexId));
    }
  }
  if (entries.length === 0) return '';
  return JSON.stringify({ models: entries }, null, 2) + '\n';
}

/**
 * Write the generated catalog to `models.json` (the repo file linked to
 * `~/.codex/models.json`). Idempotent — no-op when the content already matches.
 *
 * @param {string} codexModelsPath  Path to the repo's `models.json`.
 * @param {string} generated        Output of `generateModelsJson`.
 * @returns {{ status: 'no-change' | 'updated' | 'empty', models?: number }}
 */
export function injectModelsJson(codexModelsPath, generated) {
  if (!generated) return { status: 'empty' };
  const existing = fs.existsSync(codexModelsPath) ? fs.readFileSync(codexModelsPath, 'utf8') : null;
  if (existing === generated) return { status: 'no-change' };
  fs.writeFileSync(codexModelsPath, generated);
  return { status: 'updated', models: (generated.match(/"slug":/g) || []).length };
}

/**
 * Read the shared providers registry ONCE and (re)generate the derivable codex
 * artifacts from it:
 *   - repo `models.json` (linked to ~/.codex/models.json) — ALWAYS, regardless
 *     of whether codex_config.toml exists, because it derives purely from
 *     `providers.<name>.models`;
 *   - the `[model_providers.*]` section of `codex_config.toml` — only when that
 *     file exists (`injectModelProviders` self-guards and returns 'no-config').
 *
 * Idempotent: no file write when the generated content already matches. When
 * settings are missing/unparseable, both injectors receive '' and return
 * 'empty' WITHOUT touching any pre-existing artifact, so a last-known-good
 * models.json / codex_config.toml is preserved.
 *
 * Shared by setup.js (full install) and check-links.js (SessionStart / codex
 * launch self-heal), so a machine that syncs the repo without re-running setup
 * still gets a healable models.json source for the ~/.codex link.
 *
 * @param {{ settingsPath: string, codexConfigPath: string, modelsPath: string }} paths
 * @returns {{
 *   settings: 'missing' | 'unparseable' | 'ok',
 *   error?: Error,
 *   providers: { status: 'no-config' | 'empty' | 'no-change' | 'updated', providers?: number },
 *   models:    { status: 'empty' | 'no-change' | 'updated', models?: number },
 * }}
 */
export function regenerateCodexArtifacts({ settingsPath, codexConfigPath, modelsPath }) {
  let settings;
  let status = 'missing';
  let error;
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      status = 'ok';
    } catch (err) {
      error = err;
      status = 'unparseable';
    }
  }

  const generatedBlock = status === 'ok' ? generateModelProvidersBlock(settings) : '';
  const generatedModels = status === 'ok' ? generateModelsJson(settings) : '';

  const providers = injectModelProviders(codexConfigPath, generatedBlock);
  const models = injectModelsJson(modelsPath, generatedModels);

  return { settings: status, ...(error ? { error } : {}), providers, models };
}
