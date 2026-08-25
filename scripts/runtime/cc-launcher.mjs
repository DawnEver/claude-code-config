// scripts/runtime/cc-launcher.mjs — pure helper for the `cc.js` launcher.
//
// Projects a single `providers.<name>` block from claude_env_settings.json into
// the env vars the `claude` CLI needs. The shared `claude_env_settings.json` is
// the single source of truth for both the `claude` and `codex` launchers — see
// `codex-launcher.mjs` for the codex side. Per-host details (path suffix, env-var
// name, model alias, optional extras map) live as named fields under the provider
// block; URL and apiKey are declared once.
//
// `cc.js` is a thin spawn wrapper around this; the helper is testable without
// spawning the `claude` binary.

import { existsSync } from 'fs';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';

/**
 * Build the env + args for spawning the `claude` CLI with a given provider.
 *
 * @param {object} opts
 * @param {string|null} [opts.provider]  Provider name (e.g. 'deepseek'). Null/empty
 *   for the default Anthropic backend.
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
export function buildClaudeInvocation({
  provider,
  extraArgs = [],
  envSettingsPath,
  localPath = LOCAL_ENV_SETTINGS_PATH,
}) {
  const env = { ...process.env };
  for (const k of PROVIDER_KEYS) delete env[k];

  if (!provider || provider === 'claude') {
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
      error: `Unknown provider: ${provider}. Available: ${available.join(', ') || '(none)'}` };
  }

  // Surface a clear error when the provider declares an API-key env var but no
  // apiKey was supplied (either the shared block is missing apiKey, or the local
  // file is in mixed/legacy shape and the migrator didn't touch it). Without
  // this check, the user would get an opaque 401 from a third-party endpoint.
  if (profile.claudeApiKeyEnv && !profile.apiKey) {
    return { env, args: [...extraArgs], provider, available,
      error: `Provider '${provider}' has no apiKey — add it to ~/.claude/claude_env_settings.local.json under providers.${provider}.apiKey` };
  }

  if (profile.claudeApiKeyEnv && profile.apiKey) {
    env[profile.claudeApiKeyEnv] = profile.apiKey;
  }
  if (profile.url) {
    env.ANTHROPIC_BASE_URL = profile.url + (profile.claudePath ?? '');
  }
  // Project the Claude model env vars from the single `models` source of truth.
  // `models.base` is the canonical model (→ ANTHROPIC_MODEL); optional role keys
  // (fable/opus/sonnet/haiku/subagent) override the per-class default, falling
  // back to base. Codex's model derives from the same `models` map in
  // codex-launcher.mjs — so the two hosts cannot drift.
  const m = profile.models || {};
  if (m.base) {
    env.ANTHROPIC_MODEL = m.base;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = m.fable ?? m.base;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus ?? m.base;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet ?? m.base;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku ?? m.base;
    env.CLAUDE_CODE_SUBAGENT_MODEL = m.subagent ?? m.base;
  }

  return { env, args: [...extraArgs], provider, available, error: null };
}
