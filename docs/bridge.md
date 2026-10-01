# Session bridge (v1): Telegram <-> live sessions

Per-machine daemon that mirrors every live Claude Code and Codex session on this machine
into Telegram, and injects your replies back into the **same** session. Design:
[`harness-architecture.md`](harness-architecture.md) §4-7. This page covers setup and the
as-built behaviour.

```
Telegram ── getUpdates / sendMessage ──> daemon.mjs (one per machine, owns the bot token)
                                           ├─ codex-adapter.mjs ── codex app-server proxy ──> shared Codex daemon
                                           └─ channel-hub.mjs  <── 127.0.0.1 TCP ── session-bridge channel (in each Claude session)
```

## Topology

- **One bot per machine.** `getUpdates` allows a single consumer per token, so each
  machine gets its own bot from BotFather. The daemon refuses to start twice.
- **One forum group per project**, Topics enabled. Project = the origin repo name of the
  session's cwd (all worktrees of a repo share a group). Unknown projects go to
  `bridge.fallbackChatId`; no fallback means the session is not mirrored.
- **One Topic per session**, titled `<machine>/<agent>/<branch>` (`#2`, `#3` when two live
  sessions share a branch). Telegram is a stateless view: the mapping is rebuilt from live
  sessions. `~/.claude/bridge/topics.json` only avoids creating a new Topic after a daemon
  restart; delete it freely.

## Setup (per machine)

1. **Machine name**: `node scripts/setup/setup.js --machine <NAME>` (writes
   `~/.claude/machine.json`). The daemon will not start without it.
2. **Bot**: in Telegram, talk to `@BotFather` -> `/newbot` -> copy the token. Name it after
   the machine (e.g. `ws1_bridge_bot`). `/setprivacy` -> **Disable**, so the bot sees plain
   messages in groups, not only commands.
3. **Groups**: per project, create a group, enable **Topics** (group settings), add every
   machine's bot, and promote each bot to **admin with "Manage Topics"**.
4. **Chat ids**: send a message in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` *before* the daemon runs (it would
   consume the update) and read `message.chat.id` (`-100...`). Your own user id is
   `message.from.id`.
5. **Shared config** (non-secret, synced) in `~/.claude/claude_env_settings.json`:
   ```json
   "bridge": {
     "fallbackChatId": -1001111111111,
     "projects": { "claude-code-config": { "chatId": -1002222222222 } }
   }
   ```
6. **Secrets** (machine-local, never synced) in `~/.claude/claude_env_settings.local.json`:
   ```json
   "bridge": {
     "botToken": "123456789:AA...",
     "allowedUserIds": [123456789],
     "approvalsFromTelegram": false
   }
   ```
   `allowedUserIds` gates **every** inbound message by sender (not by chat). Empty = all
   inbound is dropped.
7. **Run**: `npm run bridge` (foreground) or `npm run bridge:install` (service:
   Task Scheduler at logon via `conhost --headless` on Windows, launchd LaunchAgent on
   macOS, `systemd --user` on Linux). Also `bridge:status`, `bridge:uninstall`. The service
   runs `~/.claude/scripts/bridge/daemon.mjs` through the link, and logs to
   `~/.claude/bridge/daemon.log` (Windows) or the service manager (others).

### Codex sessions

Start sessions with `codc`. A plain `codex` TUI runs its own embedded app-server, which the
bridge cannot see; with `bridge.botToken` set, `codc` adds `--remote unix://` to every
interactive launch (bare, a prompt, `resume`, `fork`) so the TUI attaches to the shared
app-server daemon. `exec` and other non-interactive subcommands, an explicit `--remote`,
and third-party providers (`cods`, whose overrides the daemon would not apply) are left as
they are. Any persisted thread loaded in the shared daemon is picked up within ~15 s.
Prompts typed in the TUI are mirrored into the Topic as `> <prompt>`; ones sent from the
Topic are not echoed back. Ephemeral threads cannot be
subscribed (`thread/resume` needs a rollout) and are skipped. If the daemon is not running
(`codex app-server daemon version`), the bridge keeps retrying.

### Claude sessions

Claude has no shared daemon; each session loads the **session-bridge** channel
(`claude_plugins/session-bridge/`, plain Node, no dependencies, no Bun). Nothing to do by
hand once this machine has a `bridge.botToken`:

- `npm run setup` registers the user-scope MCP server (`claude mcp add -s user
  session-bridge -- node <repo>/claude_plugins/session-bridge/server.mjs`; the absolute
  path lives in this machine's `~/.claude.json`, never in synced config).
- `ccc` (and any official-provider `cc.js` launch) adds
  `--dangerously-load-development-channels server:session-bridge` by itself, because
  custom channels are not on the research-preview allowlist. Third-party providers
  (`ccds`) never get it — they lack channels.

Caveat: a session started with plain `claude` (not `ccc`) still starts the user-scope MCP
server, so a Topic appears, but without the flag Claude Code silently drops channel
messages there. Start sessions you want to drive with `ccc`.

Requires Anthropic auth (claude.ai login); third-party providers (`ccds`) lack channels.

## Using it

In a session's Topic (only allowlisted senders):

- plain text -> injected. Codex: `turn/start` when idle, `turn/steer {expectedTurnId}`
  mid-turn. Claude: a `<channel source="session-bridge">` event.
- `/status` -> idle / turn in progress / channel connected.
- `/interrupt` -> `turn/interrupt` (Codex only; Claude: Esc locally).

Output: Codex posts one `working…` message per turn, edited in place with compact progress
lines (commands, file edits, tool calls; throttled to one edit per 3 s), then the final
agent message as a new message. Claude posts whatever it sends with the channel's `reply`
tool. Long text is split at 4096 chars; 429s honour `retry_after`.

## Approvals

Default: the bridge posts `approval needed on <machine>, answer locally or via official
remote` and never answers. Opt-in per machine with `bridge.approvalsFromTelegram: true`:
Accept/Decline buttons appear, and only presses from `allowedUserIds` count — anything
else is dropped. Codex: only `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` get buttons (`{decision: accept|decline}`); other request
kinds stay notice-only. The first answer wins (TUI, remote, or Telegram); the daemon
forgets an approval once `serverRequest/resolved` arrives. Claude: the channel declares
`claude/channel/permission`, so tool prompts are relayed; a button press becomes
`notifications/claude/channel/permission`.

## Runtime files (machine-local, `~/.claude/bridge/`)

| File | Purpose |
| --- | --- |
| `runtime.json` | daemon pid, IPC port, IPC token (0600 on POSIX; profile ACL on Windows) |
| `offset.json` | last `update_id` (cache) |
| `topics.json` | `chatId|title -> topic id` (cache) |
| `daemon.log` | Windows service log |

## Protocol notes (as built)

- `codex app-server proxy` relays bytes to the control socket, which speaks **WebSocket**;
  JSON-RPC rides text frames. `ws-stream.mjs` frames by hand (Node's `WebSocket` needs a
  URL, not a stream).
- Live Codex sessions = `thread/loaded/list`; each is subscribed with `thread/resume`.
- Daemon <-> channel IPC: newline JSON-RPC over `127.0.0.1:<random>`; the channel's first
  call must be `register {token, sessionId, cwd, branch}`.

## Unverified

- Real Telegram traffic (no token used in tests; the Bot API is faked locally).
- Channels together with `--remote-control` in one Claude session.
- Loading as a `--plugin-dir` plugin vs the `server:` entry (only the `server:` form is
  documented for development channels).
