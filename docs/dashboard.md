# Agents Dashboard (V0.1, read-only)

One Telegram Mini App showing every machine's live Claude Code / Codex sessions: host
online state, per-session status, project, branch, seat, last activity, and a jump to the
session's Topic. **V0.1 has no write path**: no prompt, approval, interrupt or session
control. The Topics stay the conversation surface; the bridge stays the session authority.

```
Native session ── adapter.statusSnapshot ── Bridge.sessions        (daemon.mjs: the only state)
                                                 │ dashboardSnapshot()  read-only projection
                                                 ▼
                                   dashboard-push.mjs  ── HTTPS POST, host bearer token ──▶ Cloudflare Worker
                                                                                          │ DashboardHub Durable Object
Telegram ─ dashboard bot ─ Mini App (public/) ─ GET /api/dashboard, Authorization: tma <initData> ┘ (registry, memory only)
```

**Optional, off by default.** Nothing here runs until a host is configured for it: the bridge
needs `bridge.botToken`, the push needs the shared `bridge.dashboard.url` and this host's local
`bridge.dashboard.hostToken`, and the statusLine records
quota only on a host that pushes (`recordsQuota` in `quota.mjs`). An unconfigured clone starts
no daemon, loads no channel and writes no series.

| Layer | File | Owns |
| --- | --- | --- |
| Export | `Bridge.dashboardSnapshot()` in `scripts/bridge/daemon.mjs` | projection of the existing registry + adapter snapshot; no new state |
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
- **Not exported**: cwd, Topic titles, tokens, and no message text. Account emails are (Quota, below).
  The session's own name is (`name`, see bridge.md; Claude's generated title is a summary of the conversation, so a
  name may echo its topic), and two counts per Topic: `unread`, the messages
  posted since the human last wrote there (a prompt typed at the machine counts as writing; reading
  without replying cannot be seen), and `mention`, while a `waiting for you` mention stands.
- **Chat list** (Config → This device): sessions drawn as Telegram lists chats: agent avatar with
  the status dot, name and time, status and where it runs, then the unread count and `@`. No message
  preview: it would put conversation content on Cloudflare. `lastActivityAt` is the bridge's last
  mirrored activity (a session with no group configured stays at its `up` time).
- The Durable Object keeps nothing on disk: when Cloudflare evicts or restarts it, the dashboard is
  empty until the next push round (`everySeconds`).

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
  exhausted window joins the needs-you card (tap it to mark it read on this device; it returns
  with the next window period). A projected run-out is shown on the account row, never alerted.
- **Events**: the Worker turns a window hitting its limit, a seat problem, or an announced extra
  reset into events (`quotaAlertsFor` in `view.mjs`), kept in the Worker (last 50, memory only)
  and shown only here — nothing is posted to Telegram. Shown in the
  Events tab, newest first, with an unread count since this device last opened it. The tab
  lists only what was unread when it was opened: events read on one visit are cleared from
  the next (per device).
- **One host model**: `hostsView()` in `public/view.mjs` is the only host list — gateway host
  (online, lastSeen, sessions, resources) plus the accounts it runs, in one order (online first,
  then by name). Sessions and Quota both render it through one host header (`hostSection` in
  `app.js`); every host is listed in both, one without accounts as "No accounts".
- **Layout**: by host — what each machine has left on each account. One compact row per
  account (both windows' bars against even pace, what is left, where else that budget runs);
  a tap opens it in place to the detail: org and plan, each window's trend on a local-time axis
  (hours for 5h, weekday and date for 7d, a line at the present), reset and forecast. A shared
  account appears under every host that runs it, marked as one budget.
- **Machine load** (Config → This device, on by default): each host's CPU % (all cores since the
  previous push), memory and, where `nvidia-smi` exists, each GPU's use and memory, under the host header of both tabs (short
  values beside each bar; core count and GPU model on a line of their own).
  Sampled by `scripts/bridge/resources.mjs` on every push; numbers and a GPU model name only.
- **Shown**: account email, org and plan; per window a bar (fill = use, line = even pace),
  the trend (spend per slice against an even spend; hatched = never observed), reset time and
  forecast; Codex reset credits; an announced extra reset (community APIs, fetched at most
  every 30 min).

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
   the variables `CLOUDFLARE_ACCOUNT_ID` and `DASHBOARD_DOMAIN` (the url's host). It never
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
| `GET /api/health` | none | `{ok, schemaVersion}` |
| `GET /api/dashboard` | `Authorization: tma <raw initData>` | `{schemaVersion, generatedAt, hosts[{id, online, lastSeen, sessions[]}]}` |
| `GET /api/hosts/:hostId/sessions` | same | one host of the above |
| `POST /api/config` | `Authorization: tma <raw initData>` | `202 {id}`: a `CONFIG_KEYS` change queued; `400` for any other key or value |
| `POST /api/hosts/:hostId/snapshot` | `Authorization: Bearer <host token>` | `{accepted}` (false = not newer than held) |

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
- Demo mode, for showing the dashboard to others: Config tab -> "This device" -> Demo mode
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
  Revert the code: additive on the bridge side — `dashboardSnapshot()`, the push, the config key.

## Known limits (V0.1)

- Polling (8 s UI, `everySeconds` push), no SSE; offline detection lags by up to `ttlSeconds`.
- Single viewer role: every allowlisted user sees every host.
- Ended sessions vanish from the next push rather than lingering as `Ended`.
