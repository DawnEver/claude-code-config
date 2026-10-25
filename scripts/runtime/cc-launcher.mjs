// scripts/runtime/cc-launcher.mjs — pure helper for the `cc.js` launcher.
//
// Projects one provider into the env vars the `claude` CLI needs: the base URL and the
// Claude-role model map from ai-lab's catalogue (the provider cache, provider-cache.mjs), the
// key from the git credential store (credential-key.mjs) into the env var the provider's
// projection rule in claude_env_settings.json names (`claudeApiKeyEnv`). The codex side is
// codex-launcher.mjs, over the same cache and rules.
//
// `cc.js` is a thin spawn wrapper around this; the helper is testable without
// spawning the `claude` binary.

import { existsSync } from 'fs';
import os from 'os';
import { baseDir, readSeats, resolveSeat, seatHome, seatsFor } from '../shared/seats.mjs';
import { PROVIDER_KEYS } from '../shared/provider-keys.js';
import { readMergedEnvSettings, LOCAL_ENV_SETTINGS_PATH } from '../shared/config.mjs';
import { readMachineName, readGitUserName, provenanceEnv } from '../shared/machine.mjs';
import { claudeResumeArgs } from '../shared/vendor-session.mjs';
import { readBridgeConfig } from '../bridge/context.mjs';
import { readProviderCache } from '../shared/provider-cache.mjs';
import { resolveProvider } from '../shared/provider-projection.mjs';
import { fetchKey as fetchStoredKey, sessionUsername } from '../shared/credential-key.mjs';
import { repoAutoModeArgs } from './repo-automode.mjs';

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
 *   notice?: string,  one line on whether the repo autoMode fragment was loaded
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
  cwd = process.cwd(),
  seats = seat === null ? [] : readSeats(),
  readCache = () => readProviderCache(),
  fetchKey = fetchStoredKey,
  // false: project everything but the key (setup-vscode writes the env into a settings file,
  // and a key is never written to a file).
  withKey = true,
  // The launch repo's .claude/automode.json for a trusted origin (repo-automode.mjs).
  repoSettings = repoAutoModeArgs,
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
  // The session id is ai-lab-session's (cc.js spawns through it); a `--continue` it cannot read is resolved here.
  extraArgs = claudeResumeArgs(extraArgs, { configDir: env.CLAUDE_CONFIG_DIR || baseDir(home), cwd });
  const repo = repoSettings({ cwd, home, extraArgs });
  const notice = repo.notice;
  extraArgs = [...repo.args, ...extraArgs];

  if (!provider || provider === 'claude') {
    // A machine with its own bot token runs the session bridge (docs/bridge.md), so every
    // official session loads its channel. Third-party providers lack channels entirely.
    const bridge = readBridgeConfig({ sharedPath: envSettingsPath, localPath });
    const channel = (bridge.botToken || bridge.dashboard)
      && !extraArgs.includes(BRIDGE_CHANNEL_ARGS[0]) ? BRIDGE_CHANNEL_ARGS : [];
    return { env, args: [...channel, ...extraArgs], provider: null, available: [], error: null, seat, seatMatch, notice };
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

  const baseUrl = row.endpoints?.anthropic;
  if (!baseUrl) return fail(`provider ${provider} declares no anthropic protocol in the ai-lab catalogue; Claude Code cannot use it`);
  env.ANTHROPIC_BASE_URL = baseUrl;

  if (rules.claudeApiKeyEnv && withKey) {
    const user = sessionUsername(provider, row);
    if (user.error) return fail(user.error);
    const got = fetchKey({ host: row.host, username: user.username });
    if (got.error) return fail(got.error);
    env[rules.claudeApiKeyEnv] = got.key;
  }
  // The Claude-role model map is the catalogue's; `base` is ANTHROPIC_MODEL and each role
  // falls back to it. Codex derives its model from the same map (codex-launcher.mjs).
  const m = row.models || {};
  if (m.base) {
    env.ANTHROPIC_MODEL = m.base;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = m.fable ?? m.base;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus ?? m.base;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet ?? m.base;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku ?? m.base;
    env.CLAUDE_CODE_SUBAGENT_MODEL = m.subagent ?? m.base;
  }

  return { env, args: [...extraArgs], provider, available, error: null, notice };
}
