# Agents Dashboard (V0.1, read-only)

One Telegram Mini App showing every machine's live Claude Code / Codex sessions: host
online state, per-session status, project, branch, seat, last activity, and a jump to the
session's Topic. **V0.1 has no write path**: no prompt, approval, interrupt or session
control. The Topics stay the conversation surface; the bridge stays the session authority.

```
Native session ── adapter.statusSnapshot ── Bridge.sessions        (daemon.mjs: the only state)
                                                 │ dashboardSessions()  read-only projection
                                                 ▼
                                   dashboard-push.mjs  ── HTTPS POST, host bearer token ──▶ Cloudflare Worker
                                                                                          │ DashboardHub Durable Object
Telegram ─ dashboard bot ─ Mini App (public/) ─ GET /api/dashboard, Authorization: tma <initData> ┘ (registry: pushes in memory, alert state in storage)
```

**Optional, off by default.** Nothing here runs until a host is configured for it: the bridge
can run in telemetry-only mode without `bridge.botToken`; the push needs the shared
`bridge.dashboard.url` and this host's local `bridge.dashboard.hostToken`, and the statusLine records
quota only on a host that pushes (`recordsQuota` in `quota.mjs`). An unconfigured clone starts
no daemon, loads no channel and writes no series.

Telemetry-only mode runs the same native adapters, registry, account/resource collectors
and pushers; it does not poll Telegram, create Topics or fake Telegram acknowledgements.
The Mini App's own viewer authentication remains separate from host collection. One
machine collector owns one explicitly resolved Codex home: a different home's launcher
warns instead of replacing it. Historical Codex usage is assigned an opaque home-scoped
unknown account, not whichever login happens to be current; live quota series are
partitioned by observed account and home.

| Layer | File | Owns |
| --- | --- | --- |
| Export | `Bridge.dashboardSessions()` in `scripts/bridge/daemon.mjs` | projection of the existing registry + adapter snapshot; no new state |
| Vocabulary | `scripts/dashboard/public/shared/vocab.mjs` | agents, statuses (label, rank), quota stale threshold: imported by the bridge, the schema and the page, under `public/` because the page loads only what the Worker serves |
| Contract | `scripts/shared/dashboard-schema.mjs` | wire format, status codes, Topic link rule, the trust boundary `parseHostPush` |
| Transport | `scripts/bridge/dashboard-push.mjs` | outbound push on a timer; never on the Telegram message path |
| Gateway | `scripts/dashboard/{worker,api,auth,registry}.mjs` | Worker entry + Durable Object (`worker.mjs`), the HTTP API on Web-standard Request/Response (`api.mjs`), Ed25519 viewer + host-token auth (`auth.mjs`), last push per host (`registry.mjs`) |
| Operations | `scripts/dashboard/deploy.mjs`, `wrangler.jsonc` | host tokens, deploy, menu button |
| UI | `scripts/dashboard/public/` | `view.mjs` (pure, tested), `app.js` (DOM), `index.html`, `_headers` (CSP) |

Why Cloudflare: the dashboard is the hosts' one public endpoint and belongs to no workstation.
A Worker on the free plan gives https on your own domain, no server to run, and a single
Durable Object is exactly the registry's shape (one in-memory state all requests share).
Budget: the free plan allows 100,000 Durable Object requests a day. A host samples every
`everySeconds` (15) but posts only a changed snapshot, plus a heartbeat every
`heartbeatSeconds` (60) when nothing changed: an idle host costs 1,440 a day, a busy one at
most 5,760; an open Mini App polling every 8 s 450 an hour. Over budget the dashboard is
down until 00:00 UTC; the bridge is unaffected. GitHub Pages cannot host it: static only,
no API, no authentication.

## Identities

- **Dashboard bot**: a bot of its own (`@BotFather` -> `/newbot`), the dashboard's entry point — the
  control plane belongs to no workstation, so it does not borrow a workstation's bridge bot.
  The Worker verifies `initData` by its **Ed25519 `signature`** (Telegram's third-party
  validation): it needs only the dashboard bot's numeric id and Telegram's public key, never the
  bot token. The token lives only in the local settings of the machine that sets the menu button.
- **Viewer**: allowlisted by `bridge.allowedUserIds` (the bridge's own allowlist), freshness by
  `auth_date` within `initDataMaxAgeSeconds` (default 24 h — Telegram signs initData once, at
  open, and a Topic link can reload the app with it). Every verified read answers with a
  **viewer session** of the gateway's own (`x-viewer-session`: `v1.<userId>.<expiry>.<HMAC>`,
  key made once and kept in Durable Object storage), renewed on use and valid
  `viewerSessionDays` (default 30) since the last read; the page keeps it per Telegram user and
  signs in with `Authorization: session <token>`, falling back to initData. The allowlist is
  checked on every use. Only past both does the app keep the last data and ask to be reopened.
  The page also keeps its last snapshot on the device, so a reload repaints at once, at the
  reader's scroll position. `initDataUnsafe` and any client-sent id are never trusted.
- **Host**: a bearer token per machine, minted on that machine; the Worker holds only its
  SHA-256. Read from the machine-local settings layer only: one written into the synced file
  is ignored.

## Semantics

- **Status** is the adapter's native state, mapped once (`STATUS_CODES` in daemon.mjs; the
  same codes label the status card): `working`, `idle`, `needs_approval`, `needs_input`,
  `unknown`, and `ended` for the instant a session is going down — an ended session is
  dropped from the next push rather than listed. The UI never infers a status.
  `unknown` is a live session no hook has reported on yet (a fresh start, a daemon restart):
  listed as **Connected**, not hidden.
- **Waiting**: a `needs_approval` / `needs_input` session carries `waiting` (at most
  `WAITING_MAX` = 300 characters, dropped at the boundary for any other status): what it waits
  for — Claude's channel permission request (`Bash: <description>`), else the Notification's
  text ("Claude needs your permission to use Bash"), or the question; Codex's pending approval
  (`$ <command>`, or its reason) or question. Shown as a line under the row and searched. The
  same text is already in the Topic (with the @ alert), so no dashboard-bot alert repeats it.
- **Account**: under the agent logo, the account the session spends, named as the Quota tab
  names it (`sessionAccountLabel` in `view.mjs`: its `accountTag` — seat label, else the
  email's name — else the API platform, else the Claude seat), so two seats of one agent are
  told apart; searched with its email. The session's `account` key is `accountFor` in
  `scripts/bridge/quota.mjs`.
- **Tasks**: a session carries `tasks`, what it runs besides its own turn, by kind (`TASK_KINDS`
  in `public/shared/vocab.mjs`): `shell` (Claude Bash, a Codex command), `powershell` (Claude's
  PowerShell tool; a Codex command run by powershell/pwsh, labelled by its script), `monitor`
  (Claude's Monitor: always in the background, ends when its `timeout_ms` expires — default 5 min,
  at most 30 — or the session ends), `agent` (a Claude Agent call, a Codex subagent)
  (`TaskBoard` in `scripts/bridge/tasks.mjs`, one per session): only what runs now, each with
  its start — an ended task is never reported (the board remembers it 10 min only so a late
  start cannot revive it); at most 50, each label one line of at most 200 characters: a Claude shell's `description`
  (what it does), else its command without a leading `cd … &&` and with `~` for home; an
  agent's type and description. Each task is one line of three columns — a kind tag in the
  kind's colour — an icon (default) or a word, `sh` `ps` `mon` `agent` (Config › Layout › Task
  tags); filled in the foreground, outlined in the background (a Codex unified-exec session
  too), the one mark of it — what it does,
  how long it has run. Tasks are listed by kind — subagents, monitors, shells, PowerShell
  (`TASK_KINDS` order), each kind oldest first. Folded, the row lists the first two (Config ›
  Layout › Task lines: 0, 1, 2, 3 or 5), each cut to a line, then `+N more`; its tasks icon
  (counting what runs) lists all of them with labels in full — a tap there never opens the
  Topic, the row still does.
  A turn end ends every foreground task still running (its end hook was lost; a foreground
  call cannot outlive its turn), and a foreground start stamped before that turn end arrived
  late and counts as ended. Claude's turn end is its Stop, and also the next prompt or an idle
  Notification (an interrupted turn fires no Stop); Codex's is `turn/completed` whatever its
  status (its items repaired from the turn's snapshot first). A session going down drops its board. Claude: `bridge-hook.js` reports a Bash or Agent call's start
  (PreToolUse) and end (PostToolUse, PostToolUseFailure); a call that returns having gone to the
  background — asked to, or by itself (Claude Code moves a long shell or an agent there unasked)
  — runs on. Every turn end takes the transcript as the truth for background shells and agents
  (`backgroundTasks`: started minus notified or stopped, each with its call's kind, label and
  time; Monitors are not counted; Claude wakes when one ends): one not open there has ended, and
  one open there that the board lost — a daemon restart, a dropped hook — is added back, unless
  it started before this claude process (the channel registers `startedAt`, its own start, less
  a minute): a resumed session's old shells died with their process. Codex:
  `trackItem` in `codex-adapter.mjs` reads each `commandExecution` item from `inProgress` to
  its end, and each subagent by its thread from `collabAgentToolCall.agentsStates`; a subagent
  runs past its parent's turn, and since a later collab call may never report its end, each poll
  asks Codex (`thread/read`) for every subagent running over a minute: its thread `idle`,
  `systemError` or `notLoaded` ends it. Live state
  only: no task is written to the usage store.
- **Freshness is separate.** `lastSeen` is the gateway's own clock at the last accepted push
  (host clocks are not trusted). A host silent for `ttlSeconds` (180) is Offline and every
  session it last reported carries `stale: true`, shown as `Stale`, not as its last state.
  Keep `ttlSeconds` at least three times every host's `heartbeatSeconds` (an idle host posts only then). A host silent for
  `offlineAlertSeconds` (shared `bridge.dashboard.offlineAlertSeconds`, default 300) is alerted
  offline once; its next push watches it again, without an alert (see Alerts). Hosts in
  `bridge.dashboard.offlineAlertExclude` (e.g. a laptop that sleeps) are never alerted offline.
  A Worker without `DASHBOARD_BOT_TOKEN` does not sweep at all, so no host is marked alerted for
  an alert it could not send.
- **Ordering**: a push carries `bootAt` (its daemon's start time, host clock) and `seq` (its
  tick). One not newer than the held push — an earlier boot, or the same boot's earlier tick —
  is refused, so a replaced daemon's in-flight push never overwrites its successor's. A boot
  dated more than 5 min ahead of the gateway clock is refused too; the host logs every refusal.
- **Topic link** only once Telegram confirmed the Topic (creation is lazy: many sessions have
  none) and only for a private supergroup: `https://t.me/c/<id without -100>/<topicId>`,
  opened with `Telegram.WebApp.openTelegramLink`. A closed Topic still links (marked closed);
  re-binding (resume, supersede, recreate) shows on the next push. The group id appears only
  inside that link (Telegram needs it); the chat id itself is not served.
- **Not exported**: cwd, Topic titles, and no message text (`waiting`, what a waiting session asks, is the one exception). Token counts go to the usage store, not the snapshot (`docs/usage.md`). Account emails are (Quota, below).
  The session's own name is (`name`, see bridge.md; Claude's generated title is a summary of the conversation, so a
  name may echo its topic), and two counts per Topic: `unread`, the messages
  posted since the human last wrote there (a prompt typed at the machine counts as writing; reading
  without replying cannot be seen), and `mention`, while a `waiting for you` mention stands.
  Also `posted` (a running count of posts), `lastPostAt` (shown as `reply 5m ago`, or as `reply 14:05` in 24h time — Config → Display → Time), and two message
  ids that become links opening the Topic at its first unread post (`firstUnreadUrl`) or its latest
  (`latestUrl`).
- **Unread on this device** — one per-device record per session (localStorage `dashboard.seen`,
  `{ p, w, m }`; pure logic `unreadState` / `readMark` / `unreadMark` / `syncSeen` in `view.mjs`).
  Telegram's own unread count is not visible to a bot, so the badge is the host's `unread` less what
  was already posted (`p`) when this device last read the session (`unreadHere`): a Topic read without
  replying clears here, a reply anywhere (Telegram, terminal) clears it everywhere, and a `posted` below
  `p` (daemon restart, resumed session) falls back to the host's count. A session is also unread when
  it newly waits for approval or input (`w`, forgotten when the wait ends, so the same question asked
  again is new) or was **marked unread** by hand (`m`). Badge: the number, or a dot when unread with
  no number. Reading = opening the Topic, expanding its tasks, or the row's *Mark read*: records `p`
  and the wait and clears `m`. The row's small *Mark unread* / *Mark read* toggle is a tap (no
  long-press: it works in the Mini App on a phone); *Mark all read* (a chip) reads every unread
  session. The Sessions tab counts unread sessions across all hosts, regardless of filters; search
  results are the same rows. A session first seen here starts read (no flood), gone ones are pruned,
  a malformed record or unusable localStorage falls back to memory. Observation-only sessions (no
  Topic) can only be unread through a wait or a manual mark. Tapping opens the latest post; Config →
  Display → Sessions can switch to the first unread one (the latest stands in once this device has
  read the session, since the first post still unread is then unknown).
- **Chat list** (the one session renderer, also under an account's "In use by"): sessions drawn as Telegram lists chats: agent avatar with
  the status dot, name and time, status and where it runs, then the unread count and `@`. No message
  preview: it would put conversation content on Cloudflare. `lastActivityAt` is the bridge's last
  mirrored activity (a session with no group configured stays at its `up` time).
- The Durable Object keeps the last push of each host in memory only: when Cloudflare evicts or
  restarts it, hosts and sessions are empty until the next push round (`everySeconds`). What
  each account and host was last alerted for is history no push can rebuild, so it lives in its
  storage, written only when it changes: a restart never alerts a standing condition again.

## Usage

The Usage tab reads the usage store (D1 behind this Worker): tokens, agent time and turns by day,
project, model and machine over 24 h (by hour) to 1 y. Host side, schema, SQL access and setup: `docs/usage.md`.

Tapping a project, model or machine row selects it; the chart, totals and API value then cover
only the selection, at any range. Several values of one list combine as any-of, values of
different lists as all-of (e.g. one model on one machine in two projects). Each list is
computed under the other lists' selections only, so it keeps offering what could be added, and
a selected value always stays listed (at zero if nothing matches). `GET /api/usage?days=7&project=a&model=m`
(repeat a key for several values, at most `USAGE_FILTER_MAX` (20) each, more is a 400; `project=` is the no-project bucket); each
filter is held `REPORT_TTL_MS` like a range. The selection is kept per device. Demo mode shows
masked names, so its rows do not filter.

## Quota

Each host's `AccountReader` (`scripts/bridge/quota.mjs`) groups its Claude config dirs by
seat, checks each login against `seats`, and computes every window's use, trend and forecast
(`accountModels()`); the push carries the result as `accounts[]` — numbers only, no rendering. One algorithm, on the host, where the inputs live (statusLine series, the Codex
app-server); the Worker never recomputes it.

- **Per account, not per host**: the Worker merges an account reported by several hosts
  (`key` = agent + email + org) into its freshest reading (`at`) and lists every host on it.
  An offline host's last reading still counts: use only grows until a reset.
- **On the reader's clock**: the even-spend pace and every countdown are computed in the page
  (`quotaView` in `public/view.mjs`). A reading older than 15 min is a floor (`≥` used,
  `≤` left) and forecasts nothing; a passed reset is a new window not yet started.
- **Verdict**: the binding window is the one that runs out soonest, else the fullest. Only an
  exhausted window flags the Quota tab and is alerted. A projected run-out is shown on the account row, never alerted.
- **Fresh on every open**: every page file is served `Cache-Control: no-cache` (`public/_headers`), so
  the web view revalidates (a 304 when unchanged) and a new deploy shows on the next open.
- **One host model**: `hostsView()` in `public/view.mjs` is the only host list — gateway host
  (online, lastSeen, sessions, resources) plus the accounts it runs, in one order (online first,
  then by name). Sessions and Quota both render it through one host header (`hostSection` in
  `app.js`); every host is listed in both, one without accounts as "No accounts".
- **Layout**: by host — what each machine has left on each account. One compact row per
  account (both windows' bars against even pace, what is left, where else that budget runs);
  a tap opens it in place to the detail: org and plan, each window's trend on a local-time axis
  (hours for 5h, weekday and date for 7d, a line at the present), reset and forecast. A shared
  account appears under every host that runs it, marked as one budget.
- **Machine load** (Config → Display → Layout: Detailed (default) / Compact / Off): under the host
  header of both tabs, each host's CPU % (all cores since the previous push), memory and, where
  `nvidia-smi` exists, each GPU's use and memory, as short values beside each bar. Detailed adds
  the hardware on a line of its own: CPU model, cores, memory size and type (DDR4, DDR5, LPDDR5…),
  GPU models. Load is sampled by `scripts/bridge/resources.mjs` on every push; the memory type is
  read once per daemon (Windows `Win32_PhysicalMemory`, macOS `system_profiler`, Linux `dmidecode`,
  which needs root — unknown otherwise). Numbers and model names only. In Compact a tap on a
  host's load opens it to the detailed view (that host, until tapped again or the page reloads).
- **Search** (the box above the tabs): everything the page holds — hosts (name, CPU and GPU
  model), sessions (name, project, branch, host, agent, seat, account, id), their tasks
  (commands, agent descriptions), accounts (label, email, org, plan), repositories, branches,
  pull requests and shared settings — searched in the browser (`searchAll` in `view.mjs`; every
  word must appear, case-insensitive; at most 100 results). A result opens its Topic or the
  forge, else its tab. The Usage tab's report is not searched (it is fetched per range).
- **Notification**: alerts go to the dashboard bot's chat (see Alerts); the page keeps no list
  of them. The Sessions tab's "Needs you" chip lists the sessions waiting. The card above the
  tabs only shows loading, sign-in and access errors.
- **Packed**: hosts flow down columns (CSS columns, ~340 px each) in Sessions and Quota; not a setting.
- **Host facts**: each host's read-only facts (Telegram bridge, allowed users, approvals, Codex
  sources, a dashboard error) sit under its accounts on the Quota tab.
- **Shown**: account email, org and plan; per window a bar (fill = use, line = even pace),
  the trend (spend per slice against an even spend; hatched = never observed), reset time and
  forecast; Codex reset credits; an announced extra reset (community APIs, fetched at most
  every 30 min).
- **Banked resets**: one-off resets an account was granted (Claude's "Full reset", "Fable
  reset"), each with its expiry. No API reports them, so they are recorded by hand in the
  account's detail (+ Add reset, Used) and kept by the gateway in Durable Object storage
  (`Registry.editBanked`, at most 10 per account). Below the hosts, a card covers every Claude
  account at once: each distinct reset with how many accounts hold it, **Add to all**,
  **Remove from all**, and + Add reset for all. An expired reset is hidden at once and leaves
  storage on the next edit. Read-only in demo mode.

## Accounts: subscriptions and API balances

A session spends exactly one account, and there is one account model with two kinds
(`accounts[]` in the push, `kind`):

- `quota` — a subscription (a Claude seat, the Codex login): windows, resets, forecast, alerts.
- `balance` — an API platform's balance: amounts per currency, or its read error. No windows,
  so it never binds, never alerts.

Every account is merged by key across hosts in the registry, placed under each host that reads
it by `hostsView` (full row on the first host, a `refTo` row elsewhere), and rendered by one
row component (`accountRow`): folded by default, opening to its detail and that host's own
sessions on it.

**Which account a session spends** is decided once, on its host (`quota.mjs accountFor`); the
page only looks `session.account` up. A Claude session spends its seat's subscription, a Codex
session the app-server's login, and an API-key session its platform's balance — never the
subscription beside it. A session is an API-key session when it runs on a provider: `ccds` sets
`HARNESS_PROVIDER` (cc-launcher.mjs), which the session-bridge channel reports; a `cods` thread
carries Codex's own `modelProvider` (`openai` = the subscription). Its pinned card shows the balance.

**A balance account is its configured entry**, declared once in the shared settings — never a key:

```json
"bridge": { "balances": [{ "provider": "deepseek" }, { "provider": "deepseek", "label": "lab", "keyUsername": "api-key-lab" }] }
```

Its key is `api:<provider>:<label|default>` (`balances.mjs balanceKey`), so every host reading it,
whatever key it holds, reports the same account, and a host without the key still attributes
its sessions to it. An API-key session spends its provider's unlabelled entry. Each host holding
the key (the git credential store; `keyUsername` defaults to the provider's session username in
the provider cache) reads it every 15 min in the background (`BalanceReader`). A provider is one
reader in `READERS`: DeepSeek has one (`/user/balance`, per currency). Anthropic and OpenAI expose
no balance to an API key — only spend, through an Admin key — so they read as `no balance API`.

## Alerts

Everything that needs the human is sent by the dashboard bot to each allowed user's private
chat. `notify.mjs` is the one sender and the one shape: every message is an alert of a kind in
its `ALERTS` table, worded in `alertLang` (i18n `alert.*`) as `<what happened>: <subject>`, a
detail line, then a link; plain text, no parse mode. `npm run dashboard -- test-alert` sends a
`test` alert through the same code with this machine's bot token (does the chat reach you?).
The registry judges what is worth telling, as data, and keeps no list of alerts:

| Alert | Raised by | Once per |
| --- | --- | --- |
| a window exhausted, a seat problem, an announced extra reset | `quotaAlertsFor` on each push, on the merged account | condition (recovering clears it) |
| host offline (coming back is not alerted) | `Registry.sweep`, on the Durable Object's alarm | silence past `offlineAlertSeconds` |
| a failed turn (Claude `StopFailure`, Codex `failed`) | the bridge daemon, an outbox on the push (`DashboardPush.raise`) | alert id (a push re-sent after a lost reply alerts once) |
| a config change refused by a host | `#settle` | report |

- **Budget**: the alarm is set for when the next host would turn silent, never on a fixed timer:
  while hosts push it fires at most once per `offlineAlertSeconds` (288 Durable Object requests
  a day at 300 s), and not at all once every host is alerted offline (the next push re-arms it).
  Alert state is written to storage only when it changes, never per push.
- **Failed turns**: the Topic keeps a plain `[failed] …` line and the alert links to it. A host
  without the dashboard has no other channel, so there the Topic mentions the human as before.
- A host never heard from since the Durable Object started is counted silent from that start.
- Telegram refusing a message (the user never opened the bot, or blocked it) is logged by the
  Worker, never retried.

## Code

What each code forge's repositories are doing: branches, open PRs and each head's CI, linked
to the sessions working on them.

**Read once per interval, by one host that can, coordinated by the gateway.** Every host
configured for a source declares it in its push (`forges.sources`, a source id = what is read:
kind, forge host, owner, repos). The gateway (registry.mjs, the one record per source, kept in
Durable Object storage) leases a source to the pushing host only when it is due — no good reading
within `FORGE_EVERY_MS` (5 min) and no live lease — and says so in the reply (`forgeRead`). So
however many hosts are configured, one reads; a lease lapses after `FORGE_LEASE_MS` (2 min), so a
host that dies mid-read is replaced by the next one to push; a host that reports it cannot read
(no token, forge unreachable) or whose token is refused is not asked again for `FORGE_SKIP_MS`
(30 min) and another is. A reading replaces the source's record whole, so a repeat is harmless.

**Read by the hosts that can reach each forge** (`scripts/bridge/forges.mjs`). A forge inside a
private network is read by the hosts on that network, a public one by any; the gateway never
reaches a forge and never holds a token. Each host uses its own token: `gh auth token` for
GitHub, else the git credential store entry for the forge host (store one with
`git credential approve`). A forge this host cannot reach, or has no token for, is simply not
this host's to report. Sources are configuration, in the shared settings:

```json
"bridge": { "forges": [
  { "kind": "github", "owner": "<owner>" },
  { "kind": "gitea", "base": "https://<gitea host>", "repos": ["<org>/<repo>"] } ] }
```

`owner` reads all of an owner's repos, `repos` the listed ones (both narrow together on GitHub).
`show` lists the repos the tab shows by default (absent: all); each device may choose others in
Config › Code, and *Back to the defaults* returns to `show`. The credential is the one the host's git already uses — GitHub's `gh` login, else the git
credential store entry for the forge host (`keyUsername` picks one by username). An OAuth login (Git Credential Manager)
expires within hours: refused, the reader runs one `git ls-remote` of a repo of the source, in
the user's own environment, exactly as their `git pull` does — GCM renews the login there with its
refresh token — and reads once more. The store is never written by the reader. Forcing GCM
non-interactive (`GCM_INTERACTIVE=never`) stopped that renewal and git then dropped the login.

**Nothing fails silently.** An error never replaces a good reading; a source never read well
shows its error on its repos, listed first under *Needs attention*. The daemon logs one
`forges:` line per reading it makes (repos, the forge's error, or why it cannot read).
A kind is one adapter onto one model — `Repo {key, branches, pulls}`, `Branch {name, sha, at,
author, ci}`, `Pull {number, head, base, review, conflict, ci}` — so adding GitLab is adding an
adapter. GitHub is one GraphQL query per 50 repos, newest push first, stopping at a year of
inactivity; Gitea (and Forgejo) is REST per repo, CI from each head's combined commit status,
which Gitea Actions reports. `ci` is `success | failure | pending | null`.

**One repo, one record.** Its key is `<forge host>/<owner>/<name>` (`scripts/shared/repo-key.mjs`);
a reading rides the next dashboard push and stays in the host's outbox until a push is accepted. A session carries
the key of its working tree's origin, so the tab links a session to its branch, PR and CI exactly.

**History** (commits on each default branch, pull requests opened and merged) lives in the usage
store, D1 tables `forge_commits` and `forge_pulls` (migration 0003), keyed by sha and number so a
repeat or a second host's copy is one row. The host holding a source's lease reads what changed
since its cursor (`~/.claude/bridge/forge-history-<home>.json`; a year back the first time, an
hour of overlap after) for the repos pushed or with a PR touched since, and hands it to the usage
push, which sends it in batches; the cursor moves only once all are stored. A read takes at
most ten pages per kind per repo, newest first; a window not finished (a busy repo's year) is
kept with where it stopped — a page on Gitea, a GraphQL cursor or, past search's 1000-result
cap, the oldest update read on GitHub — and the next read continues it, so history is never cut.
D1 bills rows written (free plan: 100k a day, shared with turns and quota), so the year before a
source's first read is backfill: a host reads at most 15k rows of it a day (`BACKFILL_ROWS_PER_DAY`,
counted in the cursor file) and finishes over the next days, while what is new since the cursor
is always read whole. `forge_commits` is a WITHOUT ROWID table keyed (repo, at, sha) — one row
written per commit (migration 0004; the first schema wrote three) — and an unchanged pull
request or re-sent commit writes nothing. An opened repo card
fetches `GET /api/code/history?repo=&days=&tz=` (usage-store.mjs `forgeHistory`: every hour or
day of the range, zeros included) and draws commits and PRs with the one `barChart` the Usage
tab uses. A host that takes a lease for the first time reads its year again: harmless, keyed rows.

**The tab** (`view.mjs codeView`): a range (24h / 7d / 30d / 1y, 30d by default, kept per device)
picks repos with activity in it; *Needs attention* lists a failing default branch, failing or
conflicting PRs, and failing branches a session works on; each repo is a folded row (`foldRow`,
the same component as the Quota accounts) opening to its open PRs and active branches.

## Config

The dashboard shows each host's config and may change a fixed few keys — behaviour that grants
nothing. `CONFIG_KEYS` in `scripts/shared/dashboard-schema.mjs` is the whole list:
`bridge.idleCloseMinutes` (0–1440), `bridge.deleteClosedAfterHours` (0–720),
`bridge.dashboard.everySeconds` (5–3600), `bridge.projects.<repo>.projectInTitle`
(`always`/`main`/`never`). Permissions (`allowedUserIds`, `approvalsFromTelegram`), routing
(chat ids) and secrets are never editable and never shown — only as facts (on/off, a count) —
so a compromised Cloudflare or Telegram account cannot widen who controls a host or where its
sessions go.

- **Flow**: the Mini App posts `{key, value}` to `/api/config` (signed viewer, validated
  against `CONFIG_KEYS`); the Worker queues it (one pending change per key, a newer request
  replaces an older), hands it to the next host that pushes, and to another if that host does
  not report within 2 min. The host validates it again (`applyConfigChange` in `context.mjs`),
  writes it into the shared `claude_env_settings.json` in place (the file may be a link into
  the sync dir), and reports the outcome on its next push; the last outcome per key is shown on
  its row (`configLast`, gateway memory), and a refusal is alerted. No new channel into a host:
  the change rides the reply to the host's own push.
- **Live**: a daemon checks its config and code each minute and hands over to a fresh daemon
  when either changed, so an edit applied here or synced in from another host takes effect
  within a minute on every host. A key set in a host's local
  layer overrides the shared value there; the Config tab says so.
- **Config tab, by layer**: *Display* (this device, localStorage, applies at once: language, time,
  quota unit, session grouping and order, where a Topic opens, tab bar, machine load — each a
  segmented choice with its explanation behind `?`); *Shared settings* (all hosts: `CONFIG_KEYS`
  grouped as Topic lifecycle, Dashboard, Projects; a row is marked when a host is still syncing or
  overrides it locally, and reads the change as queued → handed to a host → applied/refused, from
  `configPending` and `configLast`); *Developer* (collapsed: demo mode).
- **Language**: every word is in `public/shared/i18n.mjs` (`{key: {en, zh}}`, `t(key, lang)`;
  `CONFIG_KEYS` labels are `config.<key>` there). The default follows the Telegram user's
  `language_code` (`zh*` -> Chinese, else English); Config → Display → Language overrides it on this device.

## Setup

Dashboard membership has one home: the shared `bridge.dashboard` block of
`claude_env_settings.json` (synced). Only the host tokens are machine-local.

1. **Dashboard bot**: `@BotFather` -> `/newbot`. Its numeric id is the part of the token before `:`.
2. **Shared config** (`~/.claude/claude_env_settings.json`):
   ```json
   "bridge": { "dashboard": {
     "url": "https://dashboard.example.com",
     "botId": 1234567890,
     "everySeconds": 15,
     "hosts": { "host-a": "<sha256 from step 3>" }
   } }
   ```
   `url` is an origin (the gateway serves at its root, no path) on a domain whose DNS is on
   Cloudflare; `everySeconds` is 5..3600.
3. **On each host**: `npm run dashboard -- host-token` (after `npx wrangler login` once). It
   writes the token into this machine's `~/.claude/claude_env_settings.local.json`
   (`bridge.dashboard.hostToken`), its hash under `hosts` in the shared config, and runs the
   membership deploy. The host id is the machine's `machine.json` name. `npm run doctor`
   FAILs when a host's token and its shared entry disagree.
4. **Code deploys are automatic**: a push to `main` touching `scripts/dashboard/**` runs
   `.github/workflows/dashboard-deploy.yml` (dashboard tests, then `wrangler deploy`). It needs
   the repo secret `CLOUDFLARE_API_TOKEN` (Workers edit, scoped to the account and the zone) and
   the variable `DASHBOARD_DOMAIN` (the url's host). It never
   touches `DASHBOARD_CONFIG`, which persists across deploys.
   **Membership deploy**: `host-token` runs it; by hand (`npm run dashboard -- deploy`) only
   after changing `botId`, `allowedUserIds`, `offlineAlertSeconds` or `alertLang`. It derives the
   Worker's `DASHBOARD_CONFIG` secret (`botId`, `allowedUserIds`, `hosts`, and the optional shared
   `bridge.dashboard.offlineAlertSeconds` / `offlineAlertExclude` / `alertLang` — `en` or `zh`) from the merged config —
   never a host token — and the `DASHBOARD_BOT_TOKEN` secret from this machine's
   `bridge.dashboard.botToken` when this machine has it (step 5). Any machine can deploy: one
   without the token leaves the uploaded secret in place, so one deploy from a machine that has
   it is enough (and again after rotating it),
   and deploys to the url's domain (Cloudflare creates the DNS record and certificate).
5. **Bot token and menu button**: put the dashboard bot token into this machine's local
   `~/.claude/claude_env_settings.local.json` as `bridge.dashboard.botToken` (machine-local,
   like `bridge.botToken`; never synced; sent only to the Worker, as a secret, to send alerts), then
   `npm run dashboard -- set-menu`. It checks the token belongs to `botId`, sets the button and
   reads it back. Open the dashboard bot -> **Dashboard**.
6. **Daemons** pick the config up within a minute: each checks its config and code revision
   every minute and hands over to a fresh daemon on a change (`ensure.mjs --replace`). A configured but unusable block logs
   `dashboard: off (<reason>)`.

## API

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /api/health` | none | `{ok, schemaVersion, version: {commit, id, at}}` (the live deploy) |
| `GET /api/dashboard` | viewer: `Authorization: session <token>` or `tma <raw initData>` | `Registry.snapshot()`: `{schemaVersion, generatedAt, hosts[{id, online, lastSeen, sessions[], resources, config}], accounts[], repos[], configKeys[], configLast{}, configPending[]}` |
| `POST /api/config` | `Authorization: tma <raw initData>` | `202 {id}`: a `CONFIG_KEYS` change queued; `400` for any other key or value |
| `POST /api/resets` | viewer | `{account` or `accounts[], add: {name, expiresAt, note?}}`, `remove: id` or `drop: {name, expiresAt}` (all or none) -> `200 {banked[]}`; `400` for an unknown account or a past expiry |
| `POST /api/hosts/:hostId/resets` | `Authorization: Bearer <host token>` | the same edit, or `{}`: `200 {accounts[{key, agent, email, banked}]}` (scripts, no Telegram at hand) |
| `POST /api/hosts/:hostId/snapshot` | `Authorization: Bearer <host token>` | `{accepted, configChanges[]}` (accepted false = not newer than held; the changes this host should apply) |

Every route shares the per-client `ratePerMinute` (120), keyed by `CF-Connecting-IP`, which
Cloudflare sets and a client cannot forge. Refused hosts and viewers are logged (Workers
observability; no credential in the line). Errors are `{error: {code}}`: 401 bad, expired
or missing credentials, 403 valid Telegram user not allowlisted, 400 malformed push, 413
body over 256 KiB, 429 rate limit, 404. Internals are logged, never returned. A session entry
is whitelisted field by field; at most 200 per host.

## Style

All CSS is the one `<style>` in `public/index.html`. Rule: **components compose primitives; no
literal outside `:root`.** `dashboard.test.mjs` ("style") fails on a colour, or a px/em size in
`font`, `border-radius`, `gap`, `margin*`, `padding*`, outside `:root`; on a styled class no code
uses; and on an inline style in `app.js` other than geometry (`width`, `height`, `left`, `--scale`).

- **Tokens** (`:root`): colours from `--tg-theme-*` with fallbacks (`--bg --fg --hint --card
  --accent --accent-fg`) and derived (`--sep --hover --press --shadow`), status (`--ok --warn --bad
  --run --idle`), brands, task kinds; text `--t0..--t4`, `--tb` scaled by `--scale` (Config ›
  Text size), weights `--w-strong --w-bold`; space `--s1..--s11`, `--row-pad`, `--gap-block`;
  radii `--r-tag --r-ctl --r-card --r-pill`; control and mark sizes (`--pill-pad --chip-pad
  --badge --dot --avatar --who …`). Grid track widths stay in their rule, each commented.
- **Text roles**: title (row name, `--w-strong`); secondary (`--hint`, `--t3`: every meta, time,
  axis, key); key fact (`--fg`, `--t2`, strong: use, reset, forecast, warning, the account under
  a logo); label (secondary + strong); section header (secondary, strong, uppercase).
- **Primitives**, written as `:where(...)` so they add no specificity and a component rule refines
  them: card (`--card`, `--r-card`) and row (`--row-pad`, a `--sep` line between rows); pill
  (every small control: `--pill-pad`, `--r-pill`, `--t3`), with the chip variant (`--chip-pad`,
  `--t2`: status chips, tabs, apply), the track (tabs, segmented, range: pills on one card, the
  selected one raised) and the filled action; input; tag (`--r-tag`); badge (count) and dot.

## Develop and test

- `node --test scripts/dashboard/*.test.mjs scripts/bridge/dashboard-push.test.mjs` (also in
  `npm test`): Ed25519 auth (foreign key, other bot, expired, future, tampered, unlisted user),
  host tokens, schema, registry ordering/TTL, the API, rate limit, config derivation, view
  logic, and an end-to-end Bridge -> push -> API -> viewer run. `api.mjs` is runtime-agnostic,
  so the tests drive it with plain `Request` objects.
- The page in a real browser: `npm run test:e2e` (`scripts/dashboard/e2e.spec.mjs`; Playwright
  Chromium, `npm i` then `npx playwright install chromium` once; also run in the deploy workflow).
  Phone (touch) and desktop: each tab's scroll kept across tab switches, a reader's scroll
  (wheel, touch, keys, scrollbar) never pulled back by a poll or a pending restore, the unread
  badge (from any tab, cycling, clearing a search or filters), the read circle, task lists,
  search, no horizontal overflow at 320 px, the dark theme. Fixed clock and data, Telegram
  stubbed, no network. Not in `npm test`: it needs a browser download.
- Real Workers runtime: `npx wrangler dev` in `scripts/dashboard/` with a `.dev.vars`
  (gitignored) holding `DASHBOARD_CONFIG=<json>` (unquoted) and, for locally signed test data,
  `TELEGRAM_PUBLIC_KEY=<hex>`. A host daemon may push to it over `http://127.0.0.1`.
- UI without Telegram: open `/?mock` — built-in example data, no API call. Mock rendering is
  not dashboard acceptance.
- Demo mode, for showing the dashboard to others: Config tab -> Developer -> Demo mode
  (or open with `?demo`, which turns it on). Pure front end: a per-device setting in
  localStorage; the live data is masked in the browser by `demoMasker()` (`public/demo.mjs`),
  nothing is sent or changed on the gateway or any host. Rules, numbered by first appearance:
  machines -> `Workstation N`, seats -> `team-a/b/…`, their orgs -> `Team A/B/…`, emails ->
  `userN@example.com`, projects -> `project-a/…`, branches other than `main`/`master` ->
  `branch-N`, session ids, Topic chat ids. Free text (seat problems, config outcomes) is
  rebuilt from the templates that produce it; anything else is masked by shape plus known names.
  Config edits are off in demo. Real data still reaches the browser: allowlisted viewers only.
- Live acceptance needs the real chain: daemons pushing, the Worker deployed, the app opened
  from the dashboard bot on each client in use (Android, iOS, Desktop), a Topic link tapped.

## Failure isolation and rollback

- The push is an unref'd timer in the daemon, at most one in flight, 5 s timeout, never
  awaited by Telegram routing; a failing or refusing gateway logs once and the bridge carries on.
- Roll back a host: remove its `hostToken` (or the whole `bridge.dashboard` block). Roll
  back the gateway: `npx wrangler delete --config scripts/dashboard/wrangler.jsonc`.
  Revert the code: additive on the bridge side — `dashboardSessions()`, the push, the config key.

## Known limits (V0.1)

- Polling (8 s UI, `everySeconds` push), no SSE; offline detection lags by up to `ttlSeconds`.
- Single viewer role: every allowlisted user sees every host.
- Ended sessions vanish from the next push rather than lingering as `Ended`.
