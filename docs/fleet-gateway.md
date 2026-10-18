# Fleet gateway and Mini App (V0.1, read-only)

One Telegram Mini App showing every machine's live Claude Code / Codex sessions: host
online state, per-session status, project, branch, seat, last activity, and a jump to the
session's Topic. **V0.1 has no write path**: no prompt, approval, interrupt or session
control. The Topics stay the conversation surface; the bridge stays the session authority.

```
Native session ── adapter.statusSnapshot ── Bridge.sessions        (daemon.mjs: the only state)
                                                 │ fleetSnapshot()  read-only projection
                                                 ▼
                                   fleet-push.mjs  ── HTTPS POST, host bearer token ──▶ Cloudflare Worker
                                                                                          │ FleetHub Durable Object
Telegram ─ fleet bot ─ Mini App (public/) ─ GET /api/fleet, Authorization: tma <initData> ┘ (registry, memory only)
```

| Layer | File | Owns |
| --- | --- | --- |
| Export | `Bridge.fleetSnapshot()` in `scripts/bridge/daemon.mjs` | projection of the existing registry + adapter snapshot; no new state |
| Contract | `scripts/shared/fleet-schema.mjs` | wire format, status codes, Topic link rule, the trust boundary `parseHostPush` |
| Transport | `scripts/bridge/fleet-push.mjs` | outbound push on a timer; never on the Telegram message path |
| Gateway | `scripts/fleet-gateway/{worker,api,auth,registry}.mjs` | Worker entry + Durable Object (`worker.mjs`), the HTTP API on Web-standard Request/Response (`api.mjs`), Ed25519 viewer + host-token auth (`auth.mjs`), last push per host (`registry.mjs`) |
| Operations | `scripts/fleet-gateway/deploy.mjs`, `wrangler.jsonc` | host tokens, deploy, menu button |
| UI | `scripts/fleet-gateway/public/` | `view.mjs` (pure, tested), `app.js` (DOM), `index.html`, `_headers` (CSP) |

Why Cloudflare: the gateway is the fleet's one public endpoint and belongs to no workstation.
A Worker on the free plan gives https on your own domain, no server to run, and a single
Durable Object is exactly the registry's shape (one in-memory state all requests share).
Budget: the free plan allows 100,000 Durable Object requests a day; a host pushing every
15 s costs 5,760, an open Mini App polling every 8 s 450 an hour. Over budget the Fleet is
down until 00:00 UTC; the bridge is unaffected. GitHub Pages cannot host it: static only,
no API, no authentication.

## Identities

- **Fleet bot**: a bot of its own (`@BotFather` -> `/newbot`), the fleet's entry point — the
  control plane belongs to no workstation, so it does not borrow a workstation's bridge bot.
  The Worker verifies `initData` by its **Ed25519 `signature`** (Telegram's third-party
  validation): it needs only the fleet bot's numeric id and Telegram's public key, never the
  bot token. The token is used once, locally, to set the menu button, and stored nowhere.
- **Viewer**: allowlisted by `bridge.allowedUserIds` (the bridge's own allowlist), freshness by
  `auth_date` within `initDataMaxAgeSeconds` (default 1 h; past it the app asks to be
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
- **Not exported**: cwd, Topic titles, accounts, tokens. `lastActivityAt` is the bridge's last
  mirrored activity (a session with no group configured stays at its `up` time).
- The Durable Object keeps nothing on disk: when Cloudflare evicts or restarts it, the fleet is
  empty until the next push round (`everySeconds`).

## Setup

Fleet membership has one home: the shared `bridge.fleetGateway` block of
`claude_env_settings.json` (synced). Only the host tokens are machine-local.

1. **Fleet bot**: `@BotFather` -> `/newbot`. Its numeric id is the part of the token before `:`.
2. **Shared config** (`~/.claude/claude_env_settings.json`):
   ```json
   "bridge": { "fleetGateway": {
     "url": "https://fleet.example.com",
     "botId": 1234567890,
     "everySeconds": 15,
     "hosts": { "host-a": "<sha256 from step 3>" }
   } }
   ```
   `url` is an origin (the gateway serves at its root, no path) on a domain whose DNS is on
   Cloudflare; `everySeconds` is 5..3600.
3. **On each host**: `npm run fleet-gateway -- host-token`. It writes the token into this
   machine's `~/.claude/claude_env_settings.local.json` (`bridge.fleetGateway.hostToken`) and
   prints the line to add under `hosts` in the shared config. The host id is the machine's
   `machine.json` name.
4. **Deploy** (any one host, once per membership change): `npx wrangler login` once, then
   `npm run fleet-gateway -- deploy`. It derives the Worker's `FLEET_CONFIG` secret (`botId`,
   `allowedUserIds`, `hosts`) from the merged config — never a host token — and deploys to
   the url's domain (Cloudflare creates the DNS record and certificate).
5. **Menu button**: `FLEET_BOT_TOKEN=<token> npm run fleet-gateway -- set-menu`. The token is
   checked against `botId` and used for this one call. Open the fleet bot -> **Fleet**.
6. **Daemons** pick the config up at their next restart (`ensure.mjs` restarts a daemon whose
   config changed at the next session start). A configured but unusable block logs
   `fleet gateway: off (<reason>)`.

## API

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /api/health` | none | `{ok, schemaVersion}` |
| `GET /api/fleet` | `Authorization: tma <raw initData>` | `{schemaVersion, generatedAt, hosts[{id, online, lastSeen, sessions[]}]}` |
| `GET /api/hosts/:hostId/sessions` | same | one host of the above |
| `POST /api/hosts/:hostId/snapshot` | `Authorization: Bearer <host token>` | `{accepted}` (false = not newer than held) |

Every route shares the per-client `ratePerMinute` (120), keyed by `CF-Connecting-IP`, which
Cloudflare sets and a client cannot forge. Refused hosts and viewers are logged (Workers
observability; no credential in the line). Errors are `{error: {code}}`: 401 bad, expired
or missing credentials, 403 valid Telegram user not allowlisted, 400 malformed push, 413
body over 256 KiB, 429 rate limit, 404. Internals are logged, never returned. A session entry
is whitelisted field by field; at most 200 per host.

## Develop and test

- `node --test scripts/fleet-gateway/*.test.mjs scripts/bridge/fleet-push.test.mjs` (also in
  `npm test`): Ed25519 auth (foreign key, other bot, expired, future, tampered, unlisted user),
  host tokens, schema, registry ordering/TTL, the API, rate limit, config derivation, view
  logic, and an end-to-end Bridge -> push -> API -> viewer run. `api.mjs` is runtime-agnostic,
  so the tests drive it with plain `Request` objects.
- Real Workers runtime: `npx wrangler dev` in `scripts/fleet-gateway/` with a `.dev.vars`
  (gitignored) holding `FLEET_CONFIG=<json>` (unquoted) and, for locally signed test data,
  `TELEGRAM_PUBLIC_KEY=<hex>`. A host daemon may push to it over `http://127.0.0.1`.
- UI without Telegram: open `/?mock` — built-in example data, no API call. Mock rendering is
  not fleet acceptance.
- Live acceptance needs the real chain: daemons pushing, the Worker deployed, the app opened
  from the fleet bot on each client in use (Android, iOS, Desktop), a Topic link tapped.

## Failure isolation and rollback

- The push is an unref'd timer in the daemon, at most one in flight, 5 s timeout, never
  awaited by Telegram routing; a failing or refusing gateway logs once and the bridge carries on.
- Roll back a host: remove its `hostToken` (or the whole `bridge.fleetGateway` block). Roll
  back the gateway: `npx wrangler delete --config scripts/fleet-gateway/wrangler.jsonc`.
  Revert the code: additive on the bridge side — `fleetSnapshot()`, the push, the config key.

## Known limits (V0.1)

- Polling (8 s UI, `everySeconds` push), no SSE; offline detection lags by up to `ttlSeconds`.
- Single viewer role: every allowlisted user sees every host.
- Ended sessions vanish from the next push rather than lingering as `Ended`.
