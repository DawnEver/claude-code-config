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
import os from 'os';
import { baseDir, readSeats, resolveSeat, seatHome, seatsFor } from '../shared/seats.mjs';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';
import { readMachineName, readGitUserName, provenanceEnv } from '../shared/machine.mjs';
import { readBridgeConfig } from '../bridge/context.mjs';

export const BRIDGE_CHANNEL_ARGS = ['--dangerously-load-development-channels', 'server:session-bridge'];

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
 * @param {string|null} [opts.machine]  Fleet name (default: ~/.claude/machine.json).
 * @param {string|null} [opts.gitUserName]  Default: `git config --global user.name`.
 *   Together they drive provenanceEnv() — see scripts/shared/machine.mjs.
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
  machine = readMachineName(),
  gitUserName = machine ? readGitUserName() : null,
  seat = null,
  home = os.homedir(),
  seats = seat === null ? [] : readSeats(),
}) {
  const env = { ...process.env };
  for (const k of PROVIDER_KEYS) delete env[k];
  Object.assign(env, provenanceEnv({ machine, agent: 'claude', userName: gitUserName, env }));
  // The launcher alone picks the config dir: a seat's (scripts/shared/seats.mjs), else the
  // base dir, even when started from a shell that inherited another seat's CLAUDE_CONFIG_DIR.
  delete env.CLAUDE_CONFIG_DIR;
  let seatMatch = null;
  if (seat !== null) {
    const fail = (error) => ({ env, args: [...extraArgs], provider: provider || null, available: [], error });
    if (provider && provider !== 'claude') return fail(`--seat is a subscription login; it does not apply to provider ${provider}`);
    const picked = resolveSeat(seat, seatsFor(seats, machine).map((s) => s.alias).filter(Boolean));
    if (picked.error) return fail(picked.error);
    seat = picked.alias;
    seatMatch = picked.match;
    // The seat the base dir's login holds runs there: one login, never a copied credential.
    const dir = seatHome(seat, seats, machine, home);
    if (!existsSync(dir)) return fail(`no seat dir ${dir}: add seat ${seat} for this machine to \`seats\` in claude_env_settings.json, then run setup`);
    if (dir !== baseDir(home)) env.CLAUDE_CONFIG_DIR = dir;
  }

  if (!provider || provider === 'claude') {
    // A machine with its own bot token runs the session bridge (docs/bridge.md), so every
    // official session loads its channel. Third-party providers lack channels entirely.
    const channel = readBridgeConfig({ sharedPath: envSettingsPath, localPath }).botToken
      && !extraArgs.includes(BRIDGE_CHANNEL_ARGS[0]) ? BRIDGE_CHANNEL_ARGS : [];
    return { env, args: [...channel, ...extraArgs], provider: null, available: [], error: null, seat, seatMatch };
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
