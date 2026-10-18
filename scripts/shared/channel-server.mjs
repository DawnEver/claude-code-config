// The session bridge's Claude channel is a user-scope MCP server (`ccc` loads it with
// `--dangerously-load-development-channels server:session-bridge`). Its registration lives
// in each config dir's own `.claude.json` (base and every seat), so the absolute repo path
// never syncs — and the CLI can lose it when it recreates that file. Without it the session
// starts fine and is silently absent from Telegram and the dashboard, so `ccc` re-ensures it
// on every launch, setup registers it, and doctor fails on a gap.
//
// Written directly rather than via `claude mcp add`: no CLI spawn per launch, and that
// subcommand fires SessionEnd hooks outside a shell that expands `~`.
import fs from 'fs';
import path from 'path';

export const CHANNEL_SERVER = 'session-bridge';

/** The channel server inside a checkout. */
export const channelServerPath = (repoRoot) => path.join(repoRoot, 'claude_plugins', 'session-bridge', 'server.mjs');

const readConfig = (file) => {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return c && typeof c === 'object' ? c : null; } catch { return null; }
};

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => typeof a === 'string' && norm(a) === norm(b);

/** 'ok' | 'missing' | 'stale' (registered at another path) | 'no-config' (absent or unreadable). */
export function channelServerState(file, serverPath) {
  const config = readConfig(file);
  if (!config) return 'no-config';
  const entry = config.mcpServers?.[CHANNEL_SERVER];
  if (!entry) return 'missing';
  return samePath(entry.args?.[0], serverPath) ? 'ok' : 'stale';
}

/** Register the channel server in a `.claude.json`; true when written. Never creates or repairs one. */
export function ensureChannelServer(file, serverPath) {
  const config = readConfig(file);
  if (!config || channelServerState(file, serverPath) === 'ok') return false;
  config.mcpServers = { ...config.mcpServers, [CHANNEL_SERVER]: { type: 'stdio', command: 'node', args: [serverPath], env: {} } };
  // Write-then-rename: a running session may read this file at any moment.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
  return true;
}
