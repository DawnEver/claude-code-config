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

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';
import { readBridgeConfig } from '../bridge/context.mjs';
import { readProviderCache } from '../shared/provider-cache.mjs';
import { resolveProvider } from '../shared/provider-projection.mjs';
import { fetchKey as fetchStoredKey, sessionUsername } from '../shared/credential-key.mjs';
import { codexResumeArgs } from '../shared/vendor-session.mjs';
import { resolveCodexHome } from '../shared/codex-home.mjs';
import { LOCAL_ONLY_ENV } from '../shared/local-only.mjs';

const LOCAL_ONLY_ARGS = ['--config', 'mcp_servers={}', '--config', 'web_search="disabled"', '--config', 'analytics.enabled=false'];

// Subcommands that open the interactive TUI; every other subcommand (exec, app-server, ...)
// is non-interactive and must not be redirected. A bare positional is the TUI's prompt.
const TUI_SUBCOMMANDS = new Set(['resume', 'fork']);
const NON_TUI_SUBCOMMANDS = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive',
  'delete', 'migrate-rollouts', 'unarchive', 'cloud', 'exec-server', 'features', 'agents', 'help']);

function isInteractiveTui(args) {
  if (args.includes('--no-daemon')) return false;
  if (args.includes('--remote') || args.some((a) => a.startsWith('--remote='))) return false;
  if (args.some((a) => a === '-h' || a === '--help' || a === '-V' || a === '--version')) return false;
  // Option values are not subcommands (e.g. `--model x exec prompt`).
  const takesValue = new Set(['--config', '-c', '--model', '-m', '--profile', '-p', '--cd', '-C',
    '--image', '-i', '--add-dir', '--sandbox', '-s', '--ask-for-approval', '-a', '--enable', '--disable']);
  let first;
  for (let i = 0; i < args.length; i++) {
    if (takesValue.has(args[i])) { i++; continue; }
    if (args[i] === '--') { first = args[i + 1]; break; }
    if (!args[i].startsWith('-')) { first = args[i]; break; }
  }
  return first === undefined || TUI_SUBCOMMANDS.has(first) || !NON_TUI_SUBCOMMANDS.has(first);
}

// Codex-specific env vars we strip from the parent so the launcher's projection
// (or codex's own defaults) is the only source. `OPENAI_BASE_URL` is in here
// because it was silently ignored in v0.118+ — the launcher uses --config
// openai_base_url=… instead.
const CODEX_STRIP_KEYS = [
  'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'CODEX_NON_INTERACTIVE', 'CODEX_CA_CERTIFICATE',
];

const IS_WIN = process.platform === 'win32';
const DAEMON_START_TIMEOUT_MS = 30000;

/**
 * Ask Codex to start the shared app-server daemon of `env`'s CODEX_HOME. `daemon start` is Codex's own
 * idempotent verb (a running daemon answers `alreadyRunning`), and nothing else brings a dead one back: the
 * bridge only probes it. Returns null when the daemon runs, else the cause in one line.
 */
export function startCodexDaemon({ env = process.env, run = execFileSync } = {}) {
  let out;
  try {
    // On Windows `codex` is a .cmd shim, so it goes through the shell as one command string.
    out = run(IS_WIN ? 'codex app-server daemon start' : 'codex', IS_WIN ? [] : ['app-server', 'daemon', 'start'],
      { env, encoding: 'utf8', timeout: DAEMON_START_TIMEOUT_MS, windowsHide: true, shell: IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { return String(err.message).split('\n')[0]; }
  // Codex prints progress records first and its status object last.
  const status = String(out).trim().split('\n').reverse()
    .map((line) => { try { return JSON.parse(line).status; } catch { return undefined; } })
    .find((s) => s !== undefined);
  if (status === 'started' || status === 'alreadyRunning') return null;
  return status ? `the daemon reported ${status}` : 'codex app-server daemon start printed no status';
}

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
 * @param {Function} [opts.startDaemon]  Starts the shared app-server daemon before a TUI attaches
 *   (`startCodexDaemon`): null when it runs, else the cause.
 * @returns {{
 *   env: NodeJS.ProcessEnv,
 *   args: string[],
 *   provider: string|null,
 *   available: string[],
 *   error: string|null,
 *   notice?: string|null,
 * }}
 */
export function buildCodexInvocation({
  provider,
  extraArgs = [],
  envSettingsPath,
  localPath = LOCAL_ENV_SETTINGS_PATH,
  readCache = () => readProviderCache(),
  fetchKey = fetchStoredKey,
  baseEnv = process.env,
  codexHome = resolveCodexHome({ env: baseEnv }),
  startDaemon = startCodexDaemon,
}) {
  // Provenance (HARNESS_*, GIT_COMMITTER_NAME) is NOT injected here: Codex may run
  // commands in a shared daemon this env never reaches. setup writes it into
  // ~/.codex/config.toml [shell_environment_policy.set] instead — see codexShellEnv().
  // The session id is ai_lab.session's (codex.js spawns through it, so it rides that env; config.toml
  // cannot carry a per-session value). A `resume --last` it cannot read is resolved here (vendor-session.mjs).
  extraArgs = codexResumeArgs(extraArgs, { codexHome });
  const env = { ...baseEnv };
  env.CODEX_HOME = codexHome;
  for (const k of PROVIDER_KEYS) delete env[k];
  for (const k of CODEX_STRIP_KEYS) delete env[k];

  if (!provider || provider === 'codex') {
    // With the session bridge configured, an interactive TUI attaches to the shared
    // app-server daemon; a TUI on its own embedded server is invisible to the bridge.
    // The daemon is started first: `--remote` to a dead one stops the TUI at "Cannot use the background server".
    const bridge = readBridgeConfig({ sharedPath: envSettingsPath, localPath });
    const wantsAttach = Boolean(bridge.botToken || bridge.dashboard) && isInteractiveTui(extraArgs);
    const down = wantsAttach ? startDaemon({ env }) : null;
    const notice = down ? `the shared app-server daemon did not start (${down}): this session runs on its own server, `
      + 'outside the session bridge. Start it with: codex app-server daemon start' : null;
    const attach = wantsAttach && !down ? ['--remote', 'unix://'] : [];
    return { env, args: [...attach, ...extraArgs], provider: null, available: [], error: null, notice };
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
    '--config', `model_catalog_json=${join(codexHome, 'models.json')}`];
  const models = row.models || {};
  if (models.codex || models.base) args.push('--model', codexModel(models));

  if (row.auth !== 'local') return { env, args: [...args, ...extraArgs], provider, available, error: null };
  // A local row's session stays on this machine (scripts/shared/local-only.mjs): no MCP server, no web
  // search, no analytics; codex.js starts the server first.
  env[LOCAL_ONLY_ENV] = '1';
  return { env, args: [...args, ...LOCAL_ONLY_ARGS, ...extraArgs], provider, available, error: null, serve: provider };
}
