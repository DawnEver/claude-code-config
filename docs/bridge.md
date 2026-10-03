# Session bridge: Telegram <-> live sessions

Per-machine daemon that mirrors every live Claude Code and Codex session on this machine
into Telegram, and injects your replies back into the **same** session. Why it is shaped
this way: [`harness-architecture.md`](harness-architecture.md) §4-7. This page is the
single description of how it works. Pushes, verdicts and issues are
not mirrored: git and the forge own them.

```
Telegram ── getUpdates / sendMessage ──> daemon.mjs  (one per machine, owns the bot token; host-agnostic)
                                           ├─ codex-adapter.mjs  ── codex app-server proxy ──> shared Codex daemon
                                           └─ claude-adapter.mjs <── 127.0.0.1 TCP ── session-bridge channel + bridge-hook.js
```

## One model for both hosts

Each host adapter turns its host's protocol into the same events — `up {id, cwd, branch?,
backlog[]}`, `prompt {id, text, turnId?}`, `progress {id, text}`,
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
- **One Topic per session**, titled `<project> | <branch> | <machine> | <agent>`.
  Display-only project names drop a trailing `studio` or `lab` (separated by spaces,
  hyphens or underscores); configuration/routing still use the full origin repo name.
  Concurrent same-name live sessions use a stable six-hex session-derived suffix
  ` · a7c2e1`, extended only on a collision. Ended cached Topics do not reserve names.
  Reattachments rename old active Topics in place, preserving Topic/session IDs and
  an existing stable suffix. Historical inactive Topics are not bulk rewritten.
- `~/.claude/bridge/topics.json` (`chatId|<agent>:<id>` -> `{topicId, title, closedAt?}`) lets
  a session re-attach to its Topic after a daemon restart or a `--resume`; it is a cache,
  deleting it only means new Topics.

### Session lifecycle (`scripts/bridge/lifecycle.mjs`)

| From | Event | To | Telegram |
| --- | --- | --- | --- |
| — | `up` (new session) | none | nothing |
| — | `up` (cached Topic) | open / closed as cached | status card edited in place (a closed Topic reopens on activity) |
| none | activity | open | create Topic; the status card is its first message (Telegram pins it) |
| open | no activity for `idleCloseMinutes` | closed | close Topic, record `closedAt` (no message) |
| closed | activity | open | reopen the **same** Topic, clear `closedAt` |
| open | `down` | ended | status card edited to `Ended`, close Topic, record `closedAt` (no message) |
| closed / none | `down` | ended | nothing |

- **Events are messages, state is edits**: `up` and `down` post nothing; a session that
  never does anything costs no Telegram call at all. Lifecycle state is shown only by
  editing the status card.
- **Activity** = any prompt, progress, final, approval, attachment, or Telegram inject.
  The Topic is created lazily on the first one, so idle leftovers (the Codex daemon keeps
  threads loaded after their TUI exits) never get a Topic.
- **Deletion**: at startup and hourly, a Topic closed more than `deleteClosedAfterHours`
  ago is deleted (`deleteForumTopic`) and dropped from the cache, **unless a registered
  session holds it** — an idle-closed session may come back. So an idle-closed Codex
  thread keeps its Topic until the thread is unloaded; then the clock runs from that close.
- **Telegram drift**: a post refused because the Topic was closed by hand reopens it; a
  Topic deleted by hand is recreated; either way the post is resent once.

### Ordering and echoes

- Every Telegram write of a session runs on one queue, so a final never overtakes its
  prompt and the close never overtakes the last post.
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
- **`scripts/hooks/bridge-hook.js`** (wired for `UserPromptSubmit`, `Stop` and `StopFailure`) mirrors every
  prompt and the turn's final assistant text with a one-shot `mirror` call, so output does
  not depend on the model calling `reply`. Calls name the payload's `session_id` and the
  hook's `CLAUDE_CODE_SESSION_ID`, and are held up to 30 s if they beat the channel's
  registration. `/clear` evidently changes **both** ids (after it, the mirror stopped — 2026-10-02), so when no session
  matches, the hook retries naming its own nearest `claude` process (a process-table walk,
  done only on a miss because it is slow); the channel registered under that same process.
  `CLAUDE_PID` is deliberately not used: a nested `claude` (e.g. `ccc -p` run from inside a
  session) inherits its parent's, which once routed one session's output into another's
  Topic — the walk finds the nested process instead. Channel prompts are unwrapped to their text, so the echo suppression above
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
   make each bot an **admin with "Manage Topics"** (create/close/reopen/pin) and
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
     "idleCloseMinutes": 30,
     "deleteClosedAfterHours": 24
   }
   ```
   The tunables default as shown (`BRIDGE_DEFAULTS` in `scripts/bridge/context.mjs`);
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
7. **Run**: `npm run bridge` (foreground) or `npm run bridge:install` (service: a per-user
   HKCU Run key at logon via `conhost --headless` on Windows (no admin), launchd on macOS,
   `systemd --user` on Linux). Also `bridge:status`, `bridge:uninstall`. The service runs
   `~/.claude/scripts/bridge/daemon.mjs` through the link and logs to
   `~/.claude/bridge/daemon.log` (Windows) or the service manager (others).

   The service is optional: every session start runs `scripts/bridge/ensure.mjs` (Claude
   SessionStart hook; `codex.js` before launching Codex). It is a no-op without a bot
   token or when a daemon on the current source is running, starts a detached daemon when
   none is, and replaces one running older source (channels and the Codex adapter
   reconnect). Concurrent session starts are safe: the daemon takes the exclusive
   `~/.claude/bridge/daemon.lock` before polling Telegram, so at most one survives. A lock
   or runtime file written before the last boot is stale even if its pid was reused.

## Using it

In a session's Topic (allowlisted senders only):

- plain text -> injected into the session.
- `/status` -> the host's status (`idle`, `turn in progress (…)`, `channel connected`).
- `/interrupt` -> interrupts the turn where the host supports it.

Telegram lets only admins post in a closed Topic: as an admin your message reaches the bot
and reopens the Topic; a non-admin member cannot post there. Long text is split at 4096
chars; 429s honour `retry_after`.

## Approvals

Notifications: every mirrored message is sent silently. Only what waits for the human —
an approval, or a turn that ended `failed` (Codex `failed`; Claude `StopFailure`: an API error such as a rate limit) — notifies, and it mentions each `allowedUserIds`
user by id (`@you`), so it gets through a muted group or Topic.

Default: `approval needed on <machine>, answer locally or via official remote`, never
answered. Opt-in per machine with `bridge.approvalsFromTelegram: true`: Accept/Decline
buttons appear, and only presses from `allowedUserIds` on the original delivered message
count. Random references are not reused across daemon restarts; session end, channel
replacement and transport loss withdraw old controls. A press reports **submitted**,
not accepted: the native host arbitrates competing clients. Codex: only `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` are answerable (`{decision}`); the approval is forgotten
on `serverRequest/resolved`. Claude: the channel declares `claude/channel/permission`; a
press becomes `notifications/claude/channel/permission`. Claude sends no "resolved" signal,
so a prompt answered locally keeps its buttons; what Claude Code does with a late verdict is
unverified. Unknown, repeated or disconnected channel request references are rejected;
no second hook-based approval authority is installed.

### Delivery outcomes

Successful replies return acknowledged message IDs. Failed multi-part messages report
the acknowledged chunk count; transport errors are **outcome uncertain**, not proof that
Telegram received nothing. Ordinary message retries may duplicate delivery after a lost
acknowledgement. There is no exactly-once promise or independent conversation database.
Retry exhaustion is recorded in the local daemon log; consult the native session history
for missing replies. Inputs are not automatically resubmitted after an uncertain native
response, and approval decisions are never replayed across restart.

Topic creation is not retried after an uncertain transport/JSON acknowledgement. Without
a confirmed Topic the bridge does not post into the group's general chat. A definite API
rejection permits a retry on later activity; an unknown creation outcome requires checking
Telegram before restarting (the API cannot discover an orphan whose ID was lost).
Failed deletion stays in the cache for a later sweep. Do not delete a suspected orphan
until its identity and lack of a live owner have been verified.
An in-flight delete prevents re-attachment to that Topic: a returning session creates
a fresh binding. If old cleanup fails after the binding changed, a retired-topic cache
entry retains only that old transport identity for retry; it is never a live session route.

Post logs contain routing identifiers and text length, not mirrored prompt/reply content.
Transport exception URLs are not logged because they can contain bot tokens.

## Runtime files (machine-local, `~/.claude/bridge/`)

| File | Purpose |
| --- | --- |
| `runtime.json` | daemon pid, IPC port, IPC token and startup source fingerprint (0600 on POSIX; profile ACL on Windows) |
| `offset.json` | last `update_id` (cache) |
| `topics.json` | session -> Topic (cache; drives re-attach and the delete sweep) |
| `daemon.log` | Windows service log: `up`, `post`, `closed/reopened/deleted topic` lines |
| `claude-usage.json` | latest Claude statusLine `rate_limits`, teed by `hud-hook.js` for the fleet card |
| `fleet-card.json` | this machine's last fleet report id and round, and sent alert keys (cache) |
| `channel-<pid>.log` | one per Claude channel process: start (session id and its source), ancestry, decision, connect, exit; pruned after 7 days |

These files are **machine-local and contain local paths** (cwds, which include the user
name) and process ids. They are never mirrored to Telegram and never part of the synced
payload; do not paste them into shared places unredacted.

## Acceptance baseline (2026-10-02)

Evidence levels are deliberately separate: **automated** means a named fixture exercised
the behavior, **live** means an observed native-host/Telegram result, **unverified** means
no sufficient live evidence, and **unsupported** means use the native surface. A passing
unit test is not fleet acceptance. Historical live observations below are not a fresh
retest of a newly edited daemon.

Read-only baseline on Windows: `npm test` passed 367 tests, failed 0, skipped 5.
All five skips require a second writable volume (`scripts/setup/setup.test.mjs`);
cross-volume copy/link behavior remains unverified on this host. `npm run doctor`
reported 0 failures and one `payload-extra-key` warning for `model`: existing tuning
is present, but a new template-seeded install does not inherit it. Executables report
Codex 0.159.3 and Claude Code 2.1.287. `npm run bridge:status` confirms the Windows
Run entry and one live daemon process. This does **not** identify the revision loaded
by that process; disk changes do not prove running-code changes.

The real Codex integration test passed initialize and `thread/loaded/list` against
the running app-server. It does not test live injection, steering or approvals.
Recent daemon logs show successful Codex prompt/progress/final posts, but also earlier
DNS and Telegram polling failures: transport availability is not assumed continuous.
No macOS/Linux or multi-machine acceptance was performed in this baseline.

| Capability | Claude evidence | Codex evidence | Remaining live gate |
| --- | --- | --- | --- |
| Discovery/main-session filtering | Automated: channel ancestry and adapter registration | Automated: native ancestry/source filtering; live handshake/list | Concurrent main/child sessions on each platform |
| Prompt/final mirroring | Automated: hook routing, envelopes and dedupe; historical live clear recovery | Automated: deltas/backlog/final; recent live posts | Re-run after deployment, including failed turns |
| Input and echo suppression | Automated: channel injection/disconnect; historical live closed-topic input | Automated: idle start and expected-turn steering | Local/remote contention and uncertain send outcome |
| Clear/resume/fork | Historical live Claude clear; automated process-id routing | Automated user-fork classification/backlog | Resume identity and full fork isolation for both hosts |
| Command/file approvals | Historical live Claude permission button; automated relay | Automated command/file relay | Native acceptance, local-first/remote-first and stale callbacks |
| Other tool approvals | Unverified: Write/Edit/Bash/WebFetch/MCP coverage under explicit modes | Unsupported remotely outside recognized native methods | Trace emitted request, bridge relay and native outcome separately |
| Questions | Unverified channel behavior for AskUserQuestion | Native-only request_user_input | Do not infer support from ordinary text injection |
| Interrupt | Unsupported remotely; use local Esc | Automated native interrupt | Live interruption and session/turn identity |
| Failure notifications | Automated StopFailure/failure alert formatting | Automated failed-turn alert formatting | Live failure plus muted-group mention delivery |
| Restart/reconnect | Automated disconnect handling; cached-topic lifecycle | Automated transport close and subscriptions | Approved daemon restart, pending request replay and input uncertainty |
| Topic recovery/cleanup | Shared automated lifecycle/drift/delete race fixtures | Shared automated lifecycle/drift/delete race fixtures | Timed cleanup, sleep/wake, deletion failure and rebound identities |

### Isolated live verification procedure

1. Obtain confirmation before service restarts, Telegram sends/deletions or changes on
   another host. Use a dedicated test bot/token and disposable forum group; never run
   a second `getUpdates` consumer for the production bot.
2. Use a separate temporary config home and git workspace containing disposable files.
   Keep credentials machine-local. Point only the test process at its test configuration;
   do not replace the shared payload or native production trust state.
3. Run fake-host/fake-Telegram regression tests first. Record executable versions,
   platform, permission mode, process start and the source revision actually launched.
   Until running-code identity is observable, label a production process revision unknown.
4. For each case correlate native session/thread and turn/request IDs with the bridge
   reference and Telegram chat/topic/message IDs. Record event boundaries and outcomes,
   not tokens, full prompts, private paths or sensitive tool payloads. No new tracing
   subsystem is needed: existing logs plus a sanitized acceptance note suffice.
5. Claude coverage: exercise Write, Edit, safe Bash, disposable-file deletion, WebFetch,
   MCP and AskUserQuestion in main/child cases. Record local dialog -> channel -> adapter
   -> Telegram -> native result. If no host request was emitted, attribute it to native
   behavior/permission mode rather than declaring a bridge failure.
6. For both hosts test local-first/remote-first, duplicate and stale buttons, disconnect,
   clear/resume/fork and concurrent sessions. Then test lost acknowledgements, partial
   chunks, retries exhausted, manual topic drift, sleep/wake and timed cleanup. Never
   replay an uncertain input or approval merely to obtain a passing result.
7. Repeat Windows, macOS, Linux and then two-host/multi-session isolation. Unavailable
   hosts stay unverified. Clean up only the identified disposable fixtures after approval;
   preserve native operation if a remote capability fails.

Configuration ownership is defined by `sync-architecture.md`, not a second bridge
configuration manager. Existing compose/provider/setup fixtures cover idempotence and
local-state preservation; doctor is read-only. `bridge-revision` compares a live daemon's
startup SHA-256 fingerprint against current non-test bridge/shared source. It warns when
the revision is unknown or changed and never restarts the process; `ensure.mjs` does that at the next session start. This is a conservative
source fingerprint, not CLI version or Claude channel-process identity; channel updates
still need separate verification. A pre-reporting daemon is revision-unknown until
an approved restart. Live provider switching and cross-platform service behavior
require separate acceptance evidence.

## Historical live observations (2026-10-02)

- A message posted into a closed Topic reaches the session (the Topic reopens).
- Channels together with `--remote-control` in one Claude session.
- Telegram approval buttons answer a Claude permission request.
- `deleteForumTopic` on a closed Topic (create, close, delete; a later send fails).
- Mirroring after `/clear` through the process-id retry.

## Attachments

The native Claude/Codex session owns conversation and execution. Bridge owns live
session-to-Topic routing and attachment authorization; TelegramClient owns Bot API
transport and limits (`ATTACHMENT_LIMITS` in telegram.mjs). Host adapters only project
native inputs/outputs. Downloaded files are bounded transport material, not another
conversation store. Claude's MCP tool and Codex's shell command use the same Bridge
upload operation: no independent destination configuration or upload policy.

Both hosts receive photos and documents posted by allowlisted users into their exact
session Topic. Files download into the machine-local bridge uploads cache (20 MiB per
file, seven-day retention, 100 MiB cap). Names are random, not sender-controlled paths.
Codex receives images as native `localImage` inputs; Claude receives a local file
reference for its Read tool. Attachment content is untrusted, not instructions.

Claude publishes an explicitly selected workspace file with channel tool
`send_attachment` (`path`, `kind: photo|document`, optional `caption`). A fresh Claude
session is needed to load the new MCP tool. Codex uses its current `CODEX_THREAD_ID`:

```sh
node ~/.claude/scripts/bridge/send-attachment.mjs /absolute/workspace/result.png photo
node ~/.claude/scripts/bridge/send-attachment.mjs /absolute/workspace/report.pdf document
```

Destinations come from the live session, never from tool arguments. Outgoing paths must
resolve inside that session's workspace; common credential paths are blocked, but this
is not a content-based secret scanner. Review selected files before sending. Downloaded
cache files must first be explicitly copied into the workspace before republishing.
Photos are limited to 10 MiB and may be compressed by Telegram; documents are limited
to 50 MiB and preserve original bytes. Captions are plain text, at most 1024 characters.
Uncertain upload outcomes are not retried; check the Topic before another attempt.
No directory scanning or automatic artifact publication is performed.

## Fleet report (`scripts/bridge/fleet.mjs`)

Every machine reports into one shared chat/Topic, in a fixed order, at a low rate: which
seat it is on, how much quota is left, when it resets, whether it runs out first, and what
is running there. Enable it in the shared config:

```json
"bridge": { "fleet": {
  "chatId": -1001111111111, "topicId": 42, "everyMinutes": 60, "timeFormat": "date",
  "order": ["host-a", "host-b"],
  "seats": [{ "email": "alice@example.com", "org": "Team A",
              "machines": ["host-a"], "note": "reset available by 22/Oct" }]
} }
```

`topicId` is optional (absent = General); `everyMinutes` defaults to 60. Every machine's
bot must be a member of that chat. Every `everyMinutes`, each machine posts a fresh report
at its slot — one minute apart, in the order of `order` (unlisted machines last) — and deletes its previous one, so the chat holds the latest round, top to bottom.
Nothing is reported in the first minute after a daemon start, while sessions re-register.

| Line | Source |
| --- | --- |
| Claude seat | `bridge.fleet.seats` (`{email, org?, orgUuid?, machines, note?}`): the Claude account x Team each machine should run as. The shared config is never in git, so naming accounts there is fine. Codex accounts are not registered |
| Codex account | app-server `account/read` (email, plan) |
| Claude account | `~/.claude.json` `oauthAccount` (email, organization), shown in full |
| Claude 5h / 7d | statusLine `rate_limits`, teed by `hud-hook.js`; fresh only while a Claude session renders |
| Codex windows | shared app-server `account/rateLimits/read` (5-minute backstop) + `account/rateLimits/updated` |
| running | registered sessions that are not idle (`?` = connected, not yet observed) |

A report is Telegram HTML, one section per host, each headed by the full account it
actually runs as; a seat's note and checks belong to Claude, since a seat is a Claude seat.
Heads are bold, detail italic, and only the bar is monospace, so bars line up while the rest
reads in the normal font (every value is HTML-escaped). Rendered, it reads:

```
G                                              (bold)

Claude · alice@example.com                     (bold head)
Uni Team A                                     (italic)
5h ██░░░░░░░░  20%  resets 20:00               (bar in monospace)
7d ███████░░░  69%  resets 08/Oct 23:00
(!) runs out 05/Oct 21:13                      (bold)
reset available by 22/Oct                      (italic)

Codex · alice@example.com
plus
7d █████░░░░░  51%  resets 09/Oct 22:00
data 3h old                                    (italic, only when stale)

Running
• lab-commons | main | G | codex
```

`timeFormat` picks how times read: `date` (default; `HH:MM` today, `DD/Mon HH:MM`
otherwise), `countdown` (time left: `4d 7h`, `3h 15m`, `12m`) or `both`
(`08/Oct 23:00 (4d 7h)`). Pace is the average since the window
opened, as of the snapshot, so no history is kept. Freshness appears only for a snapshot
over 15 minutes old, which raises nothing. Between rounds only an alert is posted, silently and once: running
out before reset (held until that window resets), Claude logged into another account/org
than the seat (`org` = case-insensitive substring of organizationName, or exact `orgUuid`),
no subscription login on a registered machine, machine absent from a non-empty `seats`
(each held until it clears). Seats and order are re-read every tick; no restart needed.

## Session status

Each mirrored live session has one editable, pinned status card: it is the Topic's first
message, which Telegram pins itself; only a card re-sent later is pinned explicitly. It shows one state
line and the check time, e.g. `Working · since 14:02` / `Checked 14:05`; the Topic title
already names the session, and the evidence source is not shown. Native transitions update it; the refresh
button or `/status` rereads the adapter snapshot without starting a model turn.
Pinning failures do not block the card or conversation. Raw tool/search/edit progress
is suppressed for both current adapters; final answers and approvals remain visible.

- Codex: running/idle/waiting-approval derives from native turn and pending-request
  state. Submitting approval does not imply native resolution. `/interrupt` remains
  the explicit native interrupt command; no unbound stale Stop button is added.
- Claude: only Working / Idle / Unknown. Connected starts Unknown; hook prompt/final and
  channel injection give observed Working/Idle. A pending channel approval stays Working
  (it is mid-turn, and its native local resolution is not observable). Reply tool is not
  completion.
- Codex shows Working / Idle / Needs approval. Ended (either host) is transport-observed. A card is an observation, not a daemon heartbeat;
  its check time makes stale information visible if the bridge itself stops.

Card message IDs are derived transport pointers in topics.json, never another agent
state store. Reconnect/restart edits the same card with a new callback reference;
sender/chat/Topic/message authentication rejects old or foreign controls. The previous
session's pending writes drain before its replacement updates the card. A deleted
card can be recreated after a definite not-found response; uncertain creation is not
retried. Status failures never suppress native replies or backlog replay.

## Rich replies and acceptance

Final answers use native `sendRichMessage` Markdown. A user screenshot confirmed
headings, tables and code render, but dollar-delimited LaTeX appeared as source text.
A subsequent screenshot confirmed explicit mathematical_expression blocks render
powers, an integral and a matrix correctly. Native mathematical block rendering is
verified on that client. Final-answer Markdown now projects `$...$` and `$$...$$`
to explicit native math tags, preserving surrounding Markdown, code and escaped dollars.
An isolated automatic-projection test returned both inline/block mathematical expressions
and all before/after paragraphs, table, code and final marker. This is API structure
evidence; the user's earlier screenshot independently confirms native block visuals.
The subsequent automatic-projection screenshot confirms inline/display formula visuals,
all surrounding paragraphs, table and END marker, with `$x$` unchanged inside code.
No image-rendering service or PDF generator
has been added. Approval controls and failure alerts remain plain text. Definite
unsupported/format rejection falls back to chunked text; uncertain rich delivery is
neither retried nor downgraded. Original native answer text remains authoritative.

Shell/PowerShell command executions and their output are not mirrored as progress.
Approval prompts retain necessary command details for an informed decision.
Codex answers are assembled from all native final-answer items in order, deduplicated
by item ID. Turn-completion snapshots repair missed/partial stream content; explicit
commentary is not mixed into final answers. Backlog replay uses the same assembly.

Synthetic live Telegram document roundtrips preserved exact bytes; photo upload and
download succeeded with Telegram transformation. Current Codex thread outbound file
publication passed. Automated fixtures cover both hosts' attachment routing; actual
phone-originated inbound delivery and fresh Claude native image reading still need
acceptance. A user screenshot received through the bridge confirmed actual Telegram
photo download and native Codex image delivery. Claude native image reading remains
unverified. Native Remote Control attachment UI testing was waived by the user.

## Unverified

- Whether `UserPromptSubmit` fires for channel-injected prompts (either way no echo:
  the unwrap path drops it, and an unechoed inject expires).
- What Claude Code does with a Telegram verdict for a prompt already answered locally.
- The automatic 24 h sweep deleting a Topic (first candidates are due ~2026-10-03 07:00 UTC).
- The `@you` alert reaching a muted chat.
