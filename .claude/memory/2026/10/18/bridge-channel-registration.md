---
name: bridge-channel-registration
description: <machine> showed 0 sessions because the session-bridge MCP registration vanished from .claude.json; now self-healed per ccc launch and checked by doctor
---

# Bridge channel registration lost (2026-10-18)

## Symptom
- Dashboard healthy (Worker 200, `/api/health` ok, <machine> green with quotas), but <machine> listed
  0 sessions while a `ccc` session ran. Daemon log: `claude: dropped unroutable prompt/final
  for <id> (no registered channel)`.

## Root cause
- `session-bridge` user-scope MCP server missing from both `~/.claude.json` (base) and
  `~/.claude-<seat>/.claude.json`. The CLI had recreated the file (`numStartups` 4), dropping
  `mcpServers`. Only setup ever registered it, so sessions ran unbridged silently.

## Fix (uncommitted at time of writing)
- `scripts/shared/channel-server.mjs`: `channelServerState` (ok|missing|stale|no-config) and
  `ensureChannelServer` write the entry directly (write-then-rename, like
  `claude-defaults.mjs`). Not `claude mcp add`: that subcommand fires SessionEnd hooks
  without a shell expanding `~` (`Cannot find module ...\~\.claude\scripts\hooks\sync-hook.js`).
- Ensured by `cc.js` on every launch (when `bridge.botToken` set) and by `setup.js`
  (replaced its `claude mcp get/add` spawns).
- doctor `channel-server` FAIL per bridged config dir missing/stale.
- doctor `checkPlugins` now skips `@builtin` plugins (CLI-shipped, never in
  `installed_plugins.json`; was a false FAIL for `cc-plugin-you-should-know@builtin`).

## Open
- User must relaunch with `ccc` to verify <machine> sessions appear, then confirm the commit.
