# Session bridge: Telegram <-> live sessions

Per-machine daemon that mirrors every live Claude Code and Codex session on this machine
into Telegram, and injects your replies back into the **same** session. Why it is shaped
this way: [`harness-architecture.md`](harness-architecture.md) §4-7. This page is the
single description of how it works. What the bridge reports about pushes, verdicts and
issues (the `lanes` Topic) is described in [`coordination.md`](coordination.md).

```
Telegram ── getUpdates / sendMessage ──> daemon.mjs  (one per machine, owns the bot token; host-agnostic)
                                           ├─ codex-adapter.mjs  ── codex app-server proxy ──> shared Codex daemon
                                           └─ claude-adapter.mjs <── 127.0.0.1 TCP ── session-bridge channel + bridge-hook.js
```

## One model for both hosts

Each host adapter turns its host's protocol into the same events — `up {id, cwd, branch?,
preexisting, backlog[]}`, `prompt {id, text, turnId?}`, `progress {id, text}`,
`final {id, text, turnId?, status?}`, `approval {id, ref, summary, answerable}`, `down {id}`
— and offers the same interface: `inject`, `status`, `answerApproval`, and `interrupt` where
the host has one (Codex only). `daemon.mjs` has no host-specific branch; everything below
holds for Claude and Codex alike.

**Only main sessions are bridged.** Each adapter decides with one predicate,
`isMainSession`, before it emits `up`; anything else never registers, never gets a Topic,
and is never mirrored:

- Codex (`codex-adapter.mjs`, from the Thread fields): main iff `parentThreadId` is null,
  `source` is not `{subAgent: review | compact | memory_consolidation | thread_spawn | …}`,
  and `source` is not `exec` (automated runs such as fabric or sharp-review reviewers). A
  user fork (`forkedFromId`, no parent) is main. `thread/started` is judged from its payload
  without a resume; other threads are resumed once to learn it, and never again.
- Claude (`claude_plugins/session-bridge/server.mjs`): in-process subagents never touch the
  bridge. A nested `claude` process (a plugin's `claude -p`, `ccc -p` run from a session's
  shell) is detected because it inherited an outer session's `CLAUDE_PID` (a top-level
  session sets none for its MCP servers), or because a second claude process (the CLI
  binary itself, not a shim or launcher naming it) sits above its own in the process tree.
  The tree walk is best-effort: under Git Bash (MSYS) the Windows parent chain stops at
  `sh.exe`, but a session's shell always carries `CLAUDE_PID`. `channel-<pid>.log` records
  the ancestry and the decision. Its channel keeps serving MCP but never registers; its hook calls are
  dropped after the 30 s hold.
- A Topic a session got before it was known to be non-main is closed quietly
  (`dismiss`) and deleted with the other ended Topics.

### Topics

- **One bot per machine** (`getUpdates` allows one consumer per token); the daemon refuses
  to start twice.
- **One forum group per project**, Topics enabled. Project = origin repo name of the
  session's cwd, so all worktrees of a repo share a group. Unknown projects go to
  `bridge.fallbackChatId`; without one the session is registered but not mirrored.
- **One Topic per session**, titled `<machine>/<agent>/<branch>`, `#2`, `#3` when sessions
  holding a Topic in the same group share a branch.
- `~/.claude/bridge/topics.json` (`chatId|<agent>:<id>` -> `{topicId, title, closedAt?}`) lets
  a session re-attach to its Topic after a daemon restart or a `--resume`; it is a cache,
  deleting it only means new Topics.

### Session lifecycle (`scripts/bridge/lifecycle.mjs`)

| From | Event | To | Telegram |
| --- | --- | --- | --- |
| — | `up` (new session) | open | create Topic, `session up: <title> (<project>)`, unpin |
| — | `up` (leftover, see below) | none | nothing |
| — | `up` (cached Topic) | open / closed as cached | nothing (a closed one reopens on activity) |
| none | activity | open | create Topic |
| open | no activity for `idleCloseMinutes` | closed | close Topic, record `closedAt` (no message) |
| closed | activity | open | reopen the **same** Topic, clear `closedAt` |
| open | `down` | ended | `session ended: <title>`, close Topic, record `closedAt` |
| closed / none | `down` | ended | nothing |

- **Activity** = any prompt, progress, final, approval, or Telegram inject.
- **Leftovers**: the Codex daemon keeps threads loaded after their TUI exits, so a bridge
  (re)start sees threads that are long idle. Sessions already loaded at the first sync stay
  registered without a Topic until they show activity.
- **Deletion**: at startup and hourly, a Topic closed more than `deleteClosedAfterHours`
  ago is deleted (`deleteForumTopic`) and dropped from the cache, **unless a registered
  session holds it** — an idle-closed session may come back. So an idle-closed Codex
  thread keeps its Topic until the thread is unloaded; then the clock runs from that close.
- **Telegram drift**: a post refused because the Topic was closed by hand reopens it; a
  Topic deleted by hand is recreated; either way the post is resent once.

### Ordering and echoes

- Every Telegram write of a session runs on one queue, so a final never overtakes its
  prompt and the close never overtakes `session ended`.
- While a session is brought up (Topic opening, backlog replay), its live events are held,
  then released after the backlog minus the turns the backlog already carried (keyed by
  turn id: a turn that completes during bring-up is reported both ways).
- A prompt injected from the Topic is not echoed back as `> <prompt>`; an inject that
  never echoes is forgotten after 10 minutes.

## Hosts

### Codex

Start sessions with `codc`. A plain `codex` TUI runs its own embedded app-server, which the
bridge cannot see; with `bridge.botToken` set, `codc` adds `--remote unix://` to every
interactive launch (bare, a prompt, `resume`, `fork`) so the TUI attaches to the shared
app-server daemon. `exec` and other non-interactive subcommands, an explicit `--remote`,
and third-party providers (`cods`, whose overrides the daemon would not apply) are left as
they are.

- Live sessions = `thread/loaded/list`, polled every 15 s plus `thread/started`; each is
  subscribed with `thread/resume` (needs a rollout, so ephemeral threads are skipped).
  `thread/resume` also yields the backlog: turns that started after the bridge connected.
- Output: prompts, one `working…` message per turn edited in place with compact progress
  lines (throttled to one edit per 3 s), then the final agent message.
- Inject: `turn/start` when idle, `turn/steer {expectedTurnId}` mid-turn; `/interrupt` =
  `turn/interrupt`.
- `codex app-server proxy` relays bytes to the control socket, which speaks **WebSocket**;
  JSON-RPC rides text frames (`ws-stream.mjs`; Node's `WebSocket` needs a URL, not a stream).

### Claude

Claude has no shared daemon. Two pieces dial the Claude adapter on 127.0.0.1 (port and
token in `runtime.json`):

- **The session-bridge channel** (`claude_plugins/session-bridge/server.mjs`, an MCP stdio
  server on plain Node) stays connected for the life of the session:
  `register {token, sessionId, cwd}` (`sessionId` = `CLAUDE_CODE_SESSION_ID`, so `--resume`
  re-attaches), then `reply`, `permission_request`.
  Inbound Telegram text arrives in the session as a `<channel source="session-bridge">`
  event. Its socket closing is `down`.
- **`scripts/hooks/bridge-hook.js`** (wired for `UserPromptSubmit` and `Stop`) mirrors every
  prompt and the turn's final assistant text with a one-shot `mirror` call, so output does
  not depend on the model calling `reply`. Calls name the payload's `session_id` and the
  hook's `CLAUDE_CODE_SESSION_ID` (the id the process started with, which is what the channel
  registered; `/clear` mints a new payload id), and are held up to 30 s if they beat the
  channel's registration. `CLAUDE_PID` is deliberately not used: a nested `claude` (e.g.
  `ccc -p` run from inside a session) inherits its parent's, which once routed one
  session's output into another's Topic. Channel prompts are unwrapped to their text, so the echo suppression above
  drops them. A final identical to a `reply` of the same turn is not posted twice; `reply`
  stays for explicit mid-task messages.
- Only human-initiated turns are mirrored: a prompt that is wholly harness/plugin envelopes
  (`<agent-message>`, `<task-notification>`, `<system-reminder>`, `Stop hook feedback:`) is
  dropped with its final, and so is a final with no prompt since the last one (a Stop-hook
  continuation, e.g. sharp-review). A Telegram inject always opens a mirrored turn.
  Recognition lives in `isEnvelope` (`claude-adapter.mjs`).
- No `/interrupt` (use Esc locally).

Nothing to do by hand once this machine has a `bridge.botToken`: `npm run setup` registers
the user-scope MCP server (`claude mcp add -s user session-bridge -- node
<repo>/claude_plugins/session-bridge/server.mjs`; the absolute path lives in this machine's
`~/.claude.json`, never in synced config), and `ccc` (any official-provider `cc.js` launch)
adds `--dangerously-load-development-channels server:session-bridge`, because custom
channels are not on the research-preview allowlist. A plain `claude` still starts the MCP
server, so a Topic appears, but Claude Code drops channel messages without the flag.
Requires Anthropic auth; third-party providers (`ccds`) lack channels.

## Setup (per machine)

1. **Machine name**: `node scripts/setup/setup.js --machine <NAME>` (writes
   `~/.claude/machine.json`). The daemon will not start without it.
2. **Bot**: `@BotFather` -> `/newbot` -> copy the token; name it after the machine.
   `/setprivacy` -> **Disable**, so the bot sees plain messages in groups.
3. **Groups**: per project, create a group, enable **Topics**, add every machine's bot, and
   make each bot an **admin with "Manage Topics"** (create/close/reopen/unpin) and
   **"Delete messages"** (delete old closed Topics; without it the sweep logs the error once
   and retries every hour).
4. **Chat ids**: send a message in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` *before* the daemon runs (it would
   consume the update) and read `message.chat.id` (`-100...`) and your `message.from.id`.
5. **Shared config** (non-secret, synced) in `~/.claude/claude_env_settings.json`:
   ```json
   "bridge": {
     "fallbackChatId": -1001111111111,
     "projects": { "claude-code-config": { "chatId": -1002222222222 } },
     "coordinator": "<machine>",
     "idleCloseMinutes": 30,
     "deleteClosedAfterHours": 24,
     "observeIntervalSeconds": 60
   }
   ```
   `coordinator` names the machine that reports unprovenanced pushes and owns `lanes`
   ([`coordination.md`](coordination.md)). The tunables default as shown (`BRIDGE_DEFAULTS` in `scripts/bridge/context.mjs`);
   `0` = never.
6. **Secrets** (machine-local, never synced) in `~/.claude/claude_env_settings.local.json`:
   ```json
   "bridge": {
     "botToken": "123456789:AA...",
     "allowedUserIds": [123456789],
     "approvalsFromTelegram": false
   }
   ```
   `allowedUserIds` gates **every** inbound message by sender (not by chat). Empty = all
   inbound is dropped. Any key may be set in either layer; local wins.
7. **Run**: `npm run bridge` (foreground) or `npm run bridge:install` (service: Task
   Scheduler at logon via `conhost --headless` on Windows, launchd on macOS,
   `systemd --user` on Linux). Also `bridge:status`, `bridge:uninstall`. The service runs
   `~/.claude/scripts/bridge/daemon.mjs` through the link and logs to
   `~/.claude/bridge/daemon.log` (Windows) or the service manager (others).

## Using it

In a session's Topic (allowlisted senders only):

- plain text -> injected into the session.
- `/status` -> the host's status (`idle`, `turn in progress (…)`, `channel connected`).
- `/interrupt` -> interrupts the turn where the host supports it.

Telegram lets only admins post in a closed Topic: as an admin your message reaches the bot
and reopens the Topic; a non-admin member cannot post there. Long text is split at 4096
chars; 429s honour `retry_after`.

## Approvals

Default: `approval needed on <machine>, answer locally or via official remote`, never
answered. Opt-in per machine with `bridge.approvalsFromTelegram: true`: Accept/Decline
buttons appear, and only presses from `allowedUserIds` count. The first answer wins (TUI,
remote, or Telegram). Codex: only `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` are answerable (`{decision}`); the approval is forgotten
on `serverRequest/resolved`. Claude: the channel declares `claude/channel/permission`; a
press becomes `notifications/claude/channel/permission`. Claude sends no "resolved" signal,
so a prompt answered locally keeps its buttons; what Claude Code does with a late verdict is
unverified.

## Runtime files (machine-local, `~/.claude/bridge/`)

| File | Purpose |
| --- | --- |
| `runtime.json` | daemon pid, IPC port, IPC token (0600 on POSIX; profile ACL on Windows) |
| `offset.json` | last `update_id` (cache) |
| `topics.json` | session -> Topic (cache; drives re-attach and the delete sweep) |
| `daemon.log` | Windows service log: `up`, `post`, `closed/reopened/deleted topic` lines |
| `channel-<pid>.log` | one per Claude channel process: start (session id and its source), ancestry, decision, connect, exit |
| `observer.json` | last seen remote tips, issues and pending verdicts per observed repo ([`coordination.md`](coordination.md)) |

These files are **machine-local and contain local paths** (cwds, which include the user
name) and process ids. They are never mirrored to Telegram and never part of the synced
payload; do not paste them into shared places unredacted.

## Unverified

- A Telegram message posted into a closed Topic (expected: reaches the bot for admins).
- Mirroring after `/clear` (relies on the hook's `CLAUDE_CODE_SESSION_ID` keeping the
  startup id).
- Whether `UserPromptSubmit` fires for channel-injected prompts (either way no echo:
  the unwrap path drops it, and an unechoed inject expires).
- Channels together with `--remote-control` in one Claude session.
