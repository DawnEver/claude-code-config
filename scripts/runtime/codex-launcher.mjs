// scripts/runtime/codex-launcher.mjs — pure helper for the `codex.js` launcher.
//
// Projects one provider into the env + CLI flags the `codex` binary needs: the model from
// ai-lab's catalogue (the provider cache), the key from the git credential store into the
// env var the projection rule names (`codexApiKeyEnv`). Mirrors `cc-launcher.mjs` but
// targets codex's different surface: codex selects the provider via
// `--config model_provider=<name>` (which resolves base_url / env_key / wire_api
// from the `[model_providers.<name>]` block setup writes into `codex_config.toml`),
// the API key through the provider's `env_key` env var, and the model is a
// `--model` CLI flag (no env var exists).

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';
import { readBridgeConfig } from '../bridge/context.mjs';
import { readProviderCache } from '../shared/provider-cache.mjs';
import { resolveProvider } from '../shared/provider-projection.mjs';
import { fetchKey as fetchStoredKey, sessionUsername } from '../shared/credential-key.mjs';
import { sessionEnv } from '../shared/machine.mjs';

// Subcommands that open the interactive TUI; every other subcommand (exec, app-server, ...)
// is non-interactive and must not be redirected. A bare positional is the TUI's prompt.
const TUI_SUBCOMMANDS = new Set(['resume', 'fork']);
const NON_TUI_SUBCOMMANDS = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive',
  'delete', 'migrate-rollouts', 'unarchive', 'cloud', 'exec-server', 'features', 'agents', 'help']);

function isInteractiveTui(args) {
  if (args.includes('--remote') || args.some((a) => a.startsWith('--remote='))) return false;
  if (args.some((a) => a === '-h' || a === '--help' || a === '-V' || a === '--version')) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return first === undefined || TUI_SUBCOMMANDS.has(first) || !NON_TUI_SUBCOMMANDS.has(first);
}

// Codex-specific env vars we strip from the parent so the launcher's projection
// (or codex's own defaults) is the only source. `OPENAI_BASE_URL` is in here
// because it was silently ignored in v0.118+ — the launcher uses --config
// openai_base_url=… instead.
const CODEX_STRIP_KEYS = [
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'CODEX_HOME', 'CODEX_NON_INTERACTIVE', 'CODEX_CA_CERTIFICATE',
];

/**
 * Derive codex's model id from the catalogue's `models` map (the same map
 * `cc-launcher.mjs` projects). `models.codex` wins when set explicitly;
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
  readCache = () => readProviderCache(),
  fetchKey = fetchStoredKey,
}) {
  // Provenance (HARNESS_*, GIT_COMMITTER_NAME) is NOT injected here: Codex may run
  // commands in a shared daemon this env never reaches. setup writes it into
  // ~/.codex/config.toml [shell_environment_policy.set] instead — see codexShellEnv().
  // The session id is per session, so it rides this env (config.toml cannot carry it); a command
  // run in a shared daemon this env never reaches has none, and lab-commons refuses its commit.
  const env = { ...process.env, ...sessionEnv() };
  for (const k of PROVIDER_KEYS) delete env[k];
  for (const k of CODEX_STRIP_KEYS) delete env[k];

  if (!provider || provider === 'codex') {
    // With the session bridge configured, an interactive TUI attaches to the shared
    // app-server daemon; a TUI on its own embedded server is invisible to the bridge.
    const attach = readBridgeConfig({ sharedPath: envSettingsPath, localPath }).botToken
      && isInteractiveTui(extraArgs) ? ['--remote', 'unix://'] : [];
    return { env, args: [...attach, ...extraArgs], provider: null, available: [], error: null };
  }

  if (!existsSync(envSettingsPath)) {
    return { env, args: [...extraArgs], provider, available: [],
      error: `Missing: ${envSettingsPath}` };
  }

  const settings = readMergedEnvSettings({ sharedPath: envSettingsPath, localPath });
  const resolved = resolveProvider({ provider, settings, readCache });
  const { available } = resolved;
  const fail = (error) => ({ env, args: [...extraArgs], provider, available, error });
  if (resolved.error) return fail(resolved.error);
  const { rules, row } = resolved;

  if (rules.codexApiKeyEnv) {
    const user = sessionUsername(provider, row);
    if (user.error) return fail(user.error);
    const got = fetchKey({ host: row.host, username: user.username });
    if (got.error) return fail(got.error);
    env[rules.codexApiKeyEnv] = got.key;
  }
  // Select the provider's `[model_providers.<name>]` block (base_url, env_key, wire_api) that
  // setup composes into ~/.codex/config.toml from the same cache (inject-codex-providers.mjs).
  // model_catalog_json is scoped HERE (per-provider) rather than globally so plain `codex`
  // keeps OpenAI's built-in model list; it must be absolute (applied on startup, no `~`).
  const args = ['--config', `model_provider=${provider}`,
    '--config', `model_catalog_json=${join(homedir(), '.codex', 'models.json')}`];
  const models = row.models || {};
  if (models.codex || models.base) args.push('--model', codexModel(models));

  return { env, args: [...args, ...extraArgs], provider, available, error: null };
}
