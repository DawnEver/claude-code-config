// scripts/runtime/codex-launcher.mjs — pure helper for the `codex.js` launcher.
//
// Projects a single `providers.<name>` block from claude_env_settings.json into
// the env + CLI flags the `codex` binary needs. Mirrors `cc-launcher.mjs` in
// shape (same single source of truth, same provider-projection pattern) but
// targets codex's different surface: codex selects the provider via
// `--config model_provider=<name>` (which resolves base_url / env_key / wire_api
// from the `[model_providers.<name>]` block setup writes into `codex_config.toml`),
// the API key through the provider's `env_key` env var, and the model is a
// `--model` CLI flag (no env var exists).

import { existsSync } from 'fs';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';

// Codex-specific env vars we strip from the parent so the launcher's projection
// (or codex's own defaults) is the only source. `OPENAI_BASE_URL` is in here
// because it was silently ignored in v0.118+ — the launcher uses --config
// openai_base_url=… instead.
const CODEX_STRIP_KEYS = [
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'CODEX_HOME', 'CODEX_NON_INTERACTIVE', 'CODEX_CA_CERTIFICATE',
];

/**
 * Derive codex's model id from the shared `models` source of truth (the same
 * object `cc-launcher.mjs` reads). `models.codex` wins when set explicitly;
 * otherwise codex uses `models.base` with the `[1m]` context-window suffix
 * stripped — the suffix is a Claude-side request, codex uses the bare model id.
 */
function codexModel(models) {
  if (models.codex) return models.codex;
  return String(models.base).replace(/\s*\[\s*\w+\s*\]\s*$/, '');
}

/**
 * Build the env + args for spawning the `codex` CLI with a given provider.
 *
 * @param {object} opts
 * @param {string|null} [opts.provider]  Provider name (e.g. 'deepseek'). Null/empty
 *   for the default OpenAI backend.
 * @param {string[]} [opts.extraArgs]  Args to append after the launcher's own.
 * @param {string} opts.envSettingsPath  Path to the shared claude_env_settings.json.
 * @param {string} [opts.localPath]  Machine-local overlay path. Defaults to
 *   `~/.claude/claude_env_settings.local.json`.
 * @returns {{
 *   env: NodeJS.ProcessEnv,
 *   args: string[],
 *   provider: string|null,
 *   available: string[],
 *   error: string|null,
 * }}
 */
export function buildCodexInvocation({
  provider,
  extraArgs = [],
  envSettingsPath,
  localPath = LOCAL_ENV_SETTINGS_PATH,
}) {
  const env = { ...process.env };
  for (const k of PROVIDER_KEYS) delete env[k];
  for (const k of CODEX_STRIP_KEYS) delete env[k];

  if (!provider || provider === 'codex') {
    return { env, args: [...extraArgs], provider: null, available: [], error: null };
  }

  if (!existsSync(envSettingsPath)) {
    return { env, args: [...extraArgs], provider, available: [],
      error: `Missing: ${envSettingsPath}` };
  }

  const settings = readMergedEnvSettings({ sharedPath: envSettingsPath, localPath });
  const available = Object.keys(settings?.providers || {}).sort();
  const profile = settings?.providers?.[provider];

  if (!profile) {
    return { env, args: [...extraArgs], provider, available,
      error: `Unknown codex provider: ${provider}. Available: ${available.join(', ') || '(none)'}` };
  }

  // Surface a clear error when the provider declares an API-key env var but no
  // apiKey was supplied. Without this check, the user would get an opaque auth
  // error from a third-party endpoint.
  if (profile.codexApiKeyEnv && !profile.apiKey) {
    return { env, args: [...extraArgs], provider, available,
      error: `Codex provider '${provider}' has no apiKey — add it to ~/.claude/claude_env_settings.local.json under providers.${provider}.apiKey` };
  }

  const args = [];

  if (profile.codexApiKeyEnv && profile.apiKey) {
    env[profile.codexApiKeyEnv] = profile.apiKey;
  }
  // Select the provider's `[model_providers.<name>]` block (base_url, env_key,
  // wire_api) from config.toml. Previously the launcher overrode the OPENAI
  // provider's base_url with `--config openai_base_url=...`; that hijacked the
  // request (openai/chatgpt auth + openai model list) instead of using the
  // provider's own auth and wire_api — see docs/providers.md § Codex side.
  if (provider) {
    args.push('--config', `model_provider=${provider}`);
  }
  if (profile.models?.codex || profile.models?.base) {
    args.push('--model', codexModel(profile.models));
  }

  return { env, args: [...args, ...extraArgs], provider, available, error: null };
}
