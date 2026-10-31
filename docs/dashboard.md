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
Telegram ─ dashboard bot ─ Mini App (public/) ─ GET /api/dashboard, Authorization: tma <initData> ┘ (registry: pushes in memory, events in storage)
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
Budget: the free plan allows 100,000 Durable Object requests a day; a host pushing every
15 s costs 5,760, an open Mini App polling every 8 s 450 an hour. Over budget the dashboard is
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
  open, and a Topic link can reload the app with it; past it the app keeps the last data and asks to be
  reopened). `initDataUnsafe` and any client-sent id are never trusted.
- **Host**: a bearer token per machine, minted on that machine; the Worker holds only its
  SHA-256. Read from the machine-local settings layer only: one written into the synced file
  is ignored.

## Semantics

- **Status** is the adapter's native state, mapped once (`STATUS_CODES` in daemon.mjs; the
  same codes label the status card): `working`, `idle`, `needs_approval`, `needs_input`,
  `unknown`, and `ended` for the instant a session is going down — an ended session is
  dropped from the next push rather than listed. The UI never infers a status.
  A session whose host reports `unknown` is not listed at all. An `idle` Claude session
  may carry `background`: the shells and agents its turn left running, counted from the
  transcript at every turn end (`backgroundTasks` in `scripts/hooks/bridge-hook.js`: started
  minus notified or stopped; Monitors are not counted). Claude wakes when one ends, so the
  next turn end corrects it. Codex reports no such count.
- **Freshness is separate.** `lastSeen` is the gateway's own clock at the last accepted push
  (host clocks are not trusted). A host silent for `ttlSeconds` (60) is Offline and every
  session it last reported carries `stale: true`, shown as `Stale`, not as its last state.
  Keep `ttlSeconds` at least three times every host's `everySeconds`.
- **Ordering**: a push carries `bootAt` (its daemon's start time, host clock) and `seq` (its
  tick). One not newer than the held push — an earlier boot, or the same boot's earlier tick —
  is refused, so a replaced daemon's in-flight push never overwrites its successor's. A boot
  dated more than 5 min ahead of the gateway clock is refused too; the host logs every refusal.
- **Topic link** only once Telegram confirmed the Topic (creation is lazy: many sessions have
  none) and only for a private supergroup: `https://t.me/c/<id without -100>/<topicId>`,
  opened with `Telegram.WebApp.openTelegramLink`. A closed Topic still links (marked closed);
  re-binding (resume, supersede, recreate) shows on the next push. The group id appears only
  inside that link (Telegram needs it); the chat id itself is not served.
- **Not exported**: cwd, Topic titles, and no message text. Token counts go to the usage store, not the snapshot (`docs/usage.md`). Account emails are (Quota, below).
  The session's own name is (`name`, see bridge.md; Claude's generated title is a summary of the conversation, so a
  name may echo its topic), and two counts per Topic: `unread`, the messages
  posted since the human last wrote there (a prompt typed at the machine counts as writing; reading
  without replying cannot be seen), and `mention`, while a `waiting for you` mention stands.
  Also `posted` (a running count of posts), `lastPostAt` (shown as `reply 5m ago`, or as `reply 14:05` in 24h time — Config → Display → Time), and two message
  ids that become links opening the Topic at its first unread post (`firstUnreadUrl`) or its latest
  (`latestUrl`).
- **Unread on this device**: Telegram's own unread count is not visible to a bot. Opening a Topic from
  the dashboard stores that session's `posted` in localStorage; the badge is `unread` less what was
  already there then, so a Topic read without replying clears here. Tapping opens the latest post; Config → Display → Sessions can switch to the first unread one (the
  latest stands in once this device has opened the Topic, since the first post still unread is then unknown).
- **Chat list** (the one session renderer, also under an account's "In use by"): sessions drawn as Telegram lists chats: agent avatar with
  the status dot, name and time, status and where it runs, then the unread count and `@`. No message
  preview: it would put conversation content on Cloudflare. `lastActivityAt` is the bridge's last
  mirrored activity (a session with no group configured stays at its `up` time).
- The Durable Object keeps the last push of each host in memory only: when Cloudflare evicts or
  restarts it, hosts and sessions are empty until the next push round (`everySeconds`). The events
  and what each account was last alerted for are history no push can rebuild, so they live in its
  storage: a restart neither loses them nor alerts a standing condition again.

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
  exhausted window flags the Quota tab and becomes an event. A projected run-out is shown on the account row, never alerted.
- **Events**: the Worker turns a window hitting its limit, a seat problem, or an announced extra
  reset into events (`quotaAlertsFor` in `public/shared/quota-model.mjs`), stored as data
  (`{at, kind, ...}`; last 50, in Durable Object storage) and worded by the page on its own clock
  (`eventText` in `view.mjs`); shown only here — nothing is posted to Telegram. Shown in the
  Events tab, newest first, with an unread count since this device last opened it. The tab
  lists only what was unread when it was opened: events read on one visit are cleared from
  the next (per device).
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
  which needs root — unknown otherwise). Numbers and model names only.
- **Notification**: the Events tab is the one notification; the Sessions tab's "Needs you" chip
  lists the sessions waiting. The card above the tabs only shows loading, sign-in and access errors.
- **Packed**: hosts flow down columns (CSS columns, ~340 px each) in Sessions and Quota; not a setting.
- **Host facts**: each host's read-only facts (Telegram bridge, allowed users, approvals, Codex
  sources, a dashboard error) sit under its accounts on the Quota tab.
- **Shown**: account email, org and plan; per window a bar (fill = use, line = even pace),
  the trend (spend per slice against an even spend; hatched = never observed), reset time and
  forecast; Codex reset credits; an announced extra reset (community APIs, fetched at most
  every 30 min).

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
cap, the oldest update read on GitHub — and the next read continues it, so history is never cut. An opened repo card
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
  the sync dir), and reports the outcome on its next push. Requested, applied and refused are
  Events. No new channel into a host: the change rides the reply to the host's own push.
- **Live**: a daemon checks its config and code each minute and hands over to a fresh daemon
  when either changed, so an edit applied here or synced in from another host takes effect
  within a minute on every host. A key set in a host's local
  layer overrides the shared value there; the Config tab says so.
- **Config tab, by layer**: *Display* (this device, localStorage, applies at once: language, time,
  quota unit, session grouping and order, where a Topic opens, tab bar, machine load — each a
  segmented choice with its explanation behind `?`); *Shared settings* (all hosts: `CONFIG_KEYS`
  grouped as Topic lifecycle, Dashboard, Projects; a row is marked when a host is still syncing or
  overrides it locally, and reads the change as queued → handed to a host → applied/refused, from
  `configPending` and the config events); *Developer* (collapsed: demo mode).
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
   after changing `botId` or `allowedUserIds`. It derives the Worker's `DASHBOARD_CONFIG` secret (`botId`,
   `allowedUserIds`, `hosts`) from the merged config — never a host token — and deploys to
   the url's domain (Cloudflare creates the DNS record and certificate).
5. **Menu button**: put the dashboard bot token into this machine's local
   `~/.claude/claude_env_settings.local.json` as `bridge.dashboard.botToken` (machine-local,
   like `bridge.botToken`; never synced, never sent to the Worker), then
   `npm run dashboard -- set-menu`. It checks the token belongs to `botId`, sets the button and
   reads it back. Open the dashboard bot -> **Dashboard**.
6. **Daemons** pick the config up within a minute: each checks its config and code revision
   every minute and hands over to a fresh daemon on a change (as `ensure.mjs` does at session
   start). A configured but unusable block logs
   `dashboard: off (<reason>)`.

## API

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /api/health` | none | `{ok, schemaVersion, version: {commit, id, at}}` (the live deploy) |
| `GET /api/dashboard` | `Authorization: tma <raw initData>` | `Registry.snapshot()`: `{schemaVersion, generatedAt, hosts[{id, online, lastSeen, sessions[], resources, config}], accounts[], events[], configKeys[], configPending[]}` |
| `POST /api/config` | `Authorization: tma <raw initData>` | `202 {id}`: a `CONFIG_KEYS` change queued; `400` for any other key or value |
| `POST /api/hosts/:hostId/snapshot` | `Authorization: Bearer <host token>` | `{accepted, configChanges[]}` (accepted false = not newer than held; the changes this host should apply) |

Every route shares the per-client `ratePerMinute` (120), keyed by `CF-Connecting-IP`, which
Cloudflare sets and a client cannot forge. Refused hosts and viewers are logged (Workers
observability; no credential in the line). Errors are `{error: {code}}`: 401 bad, expired
or missing credentials, 403 valid Telegram user not allowlisted, 400 malformed push, 413
body over 256 KiB, 429 rate limit, 404. Internals are logged, never returned. A session entry
is whitelisted field by field; at most 200 per host.

## Develop and test

- `node --test scripts/dashboard/*.test.mjs scripts/bridge/dashboard-push.test.mjs` (also in
  `npm test`): Ed25519 auth (foreign key, other bot, expired, future, tampered, unlisted user),
  host tokens, schema, registry ordering/TTL, the API, rate limit, config derivation, view
  logic, and an end-to-end Bridge -> push -> API -> viewer run. `api.mjs` is runtime-agnostic,
  so the tests drive it with plain `Request` objects.
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
  `branch-N`, session ids, Topic chat ids. Free text (alerts, seat problems, config events) is
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
