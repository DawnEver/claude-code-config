// scripts/shared/provider-projection.mjs — join a host's projection rules with ai-lab's catalogue.
//
// claude_env_settings.json `providers.<name>` holds ONLY host projection rules: which env var
// each host reads the key from (`claudeApiKeyEnv`, `codexApiKeyEnv`). Everything else about a
// provider — url, per-protocol paths, the Claude-role model map, key usernames — is ai-lab's
// catalogue, read from the provider cache (provider-cache.mjs). A key is in the git credential
// store (credential-key.mjs). The fields that used to carry those facts here are refused by name.

/** Retired `providers.<name>` fields and where each fact lives now. */
export const RETIRED_PROVIDER_FIELDS = {
  url: "ai-lab's providers.toml (the provider cache)",
  claudePath: "ai-lab's providers.toml `anthropic_path`",
  codexPath: "ai-lab's providers.toml `openai_path`",
  models: "ai-lab's providers.toml `models`",
  apiKey: 'the git credential store (rerun setup to migrate it, or: python -m ai_lab.auth login <provider> --task session)',
};

/** An error naming every retired field still present in the merged settings, or null. */
export function retiredFieldsError(settings) {
  const found = [];
  for (const [name, block] of Object.entries(settings?.providers || {})) {
    for (const field of Object.keys(block || {})) {
      if (Object.hasOwn(RETIRED_PROVIDER_FIELDS, field)) found.push(`providers.${name}.${field} -> ${RETIRED_PROVIDER_FIELDS[field]}`);
    }
  }
  return found.length ? `retired provider field(s) in claude_env_settings[.local].json, delete them: ${found.join('; ')}` : null;
}

/**
 * The projection rules of `provider` joined with its catalogue row. The cache is read only once
 * the settings pass (a retired field or an unknown name needs an edit, not a setup run).
 * @param {{provider: string, settings: object, readCache: () => ({cache: object} | {error: string})}} opts
 * @returns {{rules: object, row: object, available: string[]} | {error: string, available: string[]}}
 */
export function resolveProvider({ provider, settings, readCache }) {
  const available = Object.keys(settings?.providers || {}).sort();
  const retired = retiredFieldsError(settings);
  if (retired) return { error: retired, available };
  const rules = settings?.providers?.[provider];
  if (!rules) return { error: `Unknown provider: ${provider}. Available: ${available.join(', ') || '(none)'}`, available };
  const read = readCache();
  if (read.error) return { error: read.error, available };
  const row = read.cache.providers?.[provider];
  if (!row) return { error: `provider ${provider} is not in the ai-lab catalogue (provider cache); add it to ai-lab's providers.toml, then rerun setup`, available };
  return { rules, row, available };
}

/** Every provider with both projection rules and a catalogue row: name -> {rules, row}. */
export function projectedProviders(settings, cache) {
  const out = {};
  for (const [name, rules] of Object.entries(settings?.providers || {})) {
    const row = cache?.providers?.[name];
    if (row) out[name] = { rules: rules || {}, row };
  }
  return out;
}
