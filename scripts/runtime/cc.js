#!/usr/bin/env node
// cc.js — Claude Code provider launcher.
//
// Thin spawn wrapper around `cc-launcher.mjs` (the pure env+args projection).
// Providers: ai-lab's catalogue via the provider cache, projection rules in
// `claude_env_settings.json` `providers.<name>`, the key from the git credential store.
// Run `node scripts/setup/setup.js` to install the `ccc` / `ccds` wrappers;
// those wrappers exec this script with the provider name.

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { syncBeforeLaunch } from './startup-sync.mjs';

// Synchronize before importing repo-owned implementation modules: git may
// replace them during a fast-forward. The host must launch with the new config,
// not a module graph cached before the update.
const sync = syncBeforeLaunch();
if (sync.notice) console.error(sync.notice);
process.env.CC_CONFIG_STARTUP_SYNCED = '1';
const [{ buildClaudeInvocation }, { prepareSpawn }, { applyGlobalDefaults }, { accountFile, configDir },
  { channelServerPath, ensureChannelServer }, { readBridgeConfig }, { ENV_SETTINGS_PATH }] = await Promise.all([
  import('./cc-launcher.mjs'),
  import('./win-spawn.mjs'),
  import('../shared/claude-defaults.mjs'),
  import('../shared/seats.mjs'),
  import('../shared/channel-server.mjs'),
  import('../bridge/context.mjs'),
  import('../shared/config.mjs'),
]);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read the shared registry through the link setup already materialized, not a repo-relative
// path: claude_env_settings.json lives in the sync payload, which may sit outside the repo.
// `~/.claude/claude_env_settings.json` is the per-host indirection that exists for exactly
// this — the same convention as ~/.claude/system-prompt.

// Prefer the link setup materializes; fall back to the repo-relative path so the launcher
// still works BEFORE the first setup run (where the old repo-relative resolution used to).
const envSettingsPath = ENV_SETTINGS_PATH;

const argv = process.argv.slice(2);
const provider = argv[0] && !argv[0].startsWith('-') ? argv.shift() : '';
// `--seat <alias>` / `-s <alias>`: run as that Claude seat (scripts/shared/seats.mjs); claude
// has neither flag.
const seatAt = argv.findIndex((a) => a === '--seat' || a === '-s');
const seat = seatAt === -1 ? null : argv.splice(seatAt, 2)[1] ?? '';
const extraArgs = argv;

const { env, args, error, seat: resolvedSeat, seatMatch } = buildClaudeInvocation({
  provider: provider || null,
  extraArgs,
  envSettingsPath,
  seat,
});

if (error) {
  console.error(error);
  process.exit(1);
}

// Anything short of the exact alias says what it resolved to, before the session starts.
if (seatMatch && (seatMatch !== 'exact' || resolvedSeat !== seat)) console.log(`[cc] seat "${seat}" matched ${resolvedSeat} (${seatMatch})`);
console.log(provider ? `[cc] Using provider: ${provider}` : `[cc] Using Claude (official subscription${resolvedSeat ? `, seat ${resolvedSeat}` : ''})`);

// Best-effort: a UI preference must never block a launch.
try { applyGlobalDefaults(accountFile(configDir(env))); } catch { /* ignore */ }
// The bridge channel's MCP registration can vanish with a recreated `.claude.json`, and the
// session would then run unbridged without a word. Best-effort, like the line above.
try {
  const bridge = readBridgeConfig();
  if ((bridge.botToken || bridge.dashboard) && ensureChannelServer(accountFile(configDir(env)), channelServerPath(REPO_ROOT))) {
    console.log('[cc] Registered the session-bridge channel server for this config dir');
  }
} catch { /* ignore */ }

// Not `shell: true`: that concatenates args unescaped, so any argument containing a space
// or a cmd metacharacter is mangled. `prepareSpawn` resolves the npm shim and quotes for us.
const launch = prepareSpawn('claude', args, { env });
const child = spawn(launch.command, launch.args, { ...launch.options, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
