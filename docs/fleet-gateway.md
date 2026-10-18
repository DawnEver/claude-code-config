# Fleet gateway and Mini App (V0.1, read-only)

One Telegram Mini App showing every machine's live Claude Code / Codex sessions: host
online state, per-session status, project, branch, seat, last activity, and a jump to the
session's Topic. **V0.1 has no write path**: no prompt, approval, interrupt or session
control. The Topics stay the conversation surface; the bridge stays the session authority.

```
Native session ── adapter.statusSnapshot ── Bridge.sessions        (daemon.mjs: the only state)
                                                 │ fleetSnapshot()  read-only projection
                                                 ▼
                                   fleet-push.mjs  ── HTTPS POST, host bearer token ──▶ gateway
                                                                                          │ registry.mjs (memory only)
Telegram ─ Mini App (public/, opened from the gateway workstation's bridge bot) ─ GET /api/fleet, Authorization: tma <initData> ───────────┘
```

| Layer | File | Owns |
| --- | --- | --- |
| Export | `Bridge.fleetSnapshot()` in `scripts/bridge/daemon.mjs` | projection of the existing registry + adapter snapshot; no new state |
| Contract | `scripts/shared/fleet-schema.mjs` | wire format, status codes, Topic link rule, the trust boundary `parseHostPush` |
| Transport | `scripts/bridge/fleet-push.mjs` | outbound push on a timer; never on the Telegram message path |
| Gateway | `scripts/fleet-gateway/{server,auth,registry}.mjs` | host + viewer authentication, last push per host, read API, static app |
| UI | `scripts/fleet-gateway/public/` | `view.mjs` (pure, tested), `app.js` (DOM), `index.html` |

Zero dependencies and no build step, like the rest of the repo: `node:http`, plain ES modules.

## Semantics

- **Status** is the adapter's native state, mapped once (`STATUS_CODES` in daemon.mjs; the
  same codes label the status card): `working`, `idle`, `needs_approval`, `needs_input`,
  `unknown`, and `ended` for the instant a session is going down — an ended session is
  dropped from the next push rather than listed. The meaning of each
  per host is `docs/bridge.md` "Session status". The UI never infers a status.
- **Freshness is separate.** `lastSeen` is the gateway's own clock at the last accepted push
  (host clocks are not trusted). A host silent for `ttlSeconds` is Offline and every session it
  last reported carries `stale: true`, shown as `Stale`, not as its last state. Keep
  `ttlSeconds` (gateway) at least three times every host's `everySeconds`, or healthy hosts
  flap Offline.
- **Ordering**: a push carries `bootAt` (its daemon's start time, host clock) and `seq` (its
  tick). One older than the held push — an earlier boot, or the same boot's earlier tick — is
  refused, so a replaced daemon's in-flight push never overwrites its successor's. A boot dated
  more than 5 min ahead of the gateway clock is refused too; the host logs every refusal.
- **Topic link** only once Telegram confirmed the Topic (creation is lazy: many sessions have
  none) and only for a private supergroup: `https://t.me/c/<id without -100>/<topicId>`,
  opened with `Telegram.WebApp.openTelegramLink`. A closed Topic still links (marked closed);
  re-binding (resume, supersede, recreate) shows on the next push. The group id appears only
  inside that link (Telegram needs it); the chat id itself is not served.
- **Not exported**: cwd, Topic titles, accounts, tokens. `lastActivityAt` is the
  bridge's last mirrored activity (a session with no group configured stays at its `up` time).
- The gateway keeps nothing on disk: a restart is empty until the next push round (`everySeconds`).

## Setup

1. **No new bot.** The gateway runs on one bridge workstation and reuses that machine's
   bridge bot and `allowedUserIds` (`readBridgeConfig`): the Mini App opens from that bot, so
   its `initData` is signed with that token. Setting a menu button does not touch the
   daemon's `getUpdates` loop.
2. **Gateway config** on that workstation, `~/.claude/fleet-gateway.json` (machine-local,
   never synced, never in git) — only what is the gateway's own:
   ```json
   {
     "hosts": { "host-a": "<sha256 from step 3>" },
     "publicUrl": "https://fleet.example.com/",
     "listen": { "host": "127.0.0.1", "port": 8787 },
     "ttlSeconds": 60, "initDataMaxAgeSeconds": 3600, "trustProxy": true, "ratePerMinute": 120
   }
   ```
   All optional, defaulting as shown (`trustProxy` false, `hosts` empty = no host can push;
   a malformed `hosts` entry stops the gateway at start). `trustProxy` keys the rate limit by
   the right-most `X-Forwarded-For` entry (the one your proxy appended); set it whenever a
   proxy is in front, else every viewer shares the proxy's bucket, and never without one.
   `initDataMaxAgeSeconds` bounds how long a captured `initData` stays usable; past it the
   app asks to be reopened. The workstation's own daemon pushes over loopback
   (`http://127.0.0.1:8787`).
3. **Per host**: `node scripts/fleet-gateway/server.mjs host-token <machine-name>` (on the
   gateway). It prints a token for the host and its hash for `hosts.<machine-name>`; only the
   hash stays on the gateway. The host id must equal that machine's `machine.json` name.
4. **HTTPS**: Telegram loads Mini Apps over https only. Run `npm run fleet-gateway`, then put
   TLS in front of the loopback port — a reverse proxy, `cloudflared tunnel`, or
   `tailscale funnel 8787`. The gateway itself never listens publicly by default.
5. **Menu button**: `node scripts/fleet-gateway/server.mjs set-menu` points that bridge bot's
   menu button at `publicUrl`. Open a private chat with the bot in Telegram -> **Fleet**.
6. **Each bridge host**:
   - shared `claude_env_settings.json`: `"bridge": { "fleetGateway": { "url": "https://fleet.example.com", "everySeconds": 15 } }`
   - local `~/.claude/claude_env_settings.local.json`: `"bridge": { "fleetGateway": { "hostToken": "<token>" } }`

   `url` is an origin (the gateway serves at its root; no path), `http://` only on loopback;
   `everySeconds` is 5..3600 (default 15); `hostToken` is read from the local layer only.
   Anything else leaves the push off and the daemon logs `fleet gateway: off (<reason>)`.
   The config change is picked up when the daemon restarts (`ensure.mjs` restarts it on
   config change at the next session start).

## API

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /api/health` | none | `{ok, schemaVersion}` |
| `GET /api/fleet` | `Authorization: tma <raw initData>` | `{schemaVersion, generatedAt, hosts[{id, online, lastSeen, sessions[]}]}` |
| `GET /api/hosts/:hostId/sessions` | same | one host of the above |
| `POST /api/hosts/:hostId/snapshot` | `Authorization: Bearer <host token>` | `{accepted}` (false = older than held) |

Every route, health and host pushes included, shares the per-client `ratePerMinute`.
Refused host pushes and viewers are logged (no credential in the line). Errors are `{error: {code}}`: 401 bad/expired/missing credentials, 403 valid Telegram user not
allowlisted, 400 malformed push, 413 body over 256 KiB, 429 rate limit, 404. Internals are
logged, never returned. `initData` is verified per
<https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app> (HMAC with
the gateway workstation's bridge bot token, `auth_date` within `initDataMaxAgeSeconds`); `initDataUnsafe` and any
client-sent id are never trusted. A session entry is whitelisted field by field; at most 200 per host.

## Develop and test

- `npm run fleet-gateway -- host-token <id>` / `-- set-menu` / `-- --config <file>` run the subcommands.
- `npm test` (or `node --test scripts/fleet-gateway/*.test.mjs scripts/bridge/fleet-push.test.mjs`; `view.mjs`
  is tested from `scripts/fleet-gateway/gateway.test.mjs`):
  auth (forged, expired, foreign bot, unlisted user), schema, registry ordering/TTL, the HTTP
  API, view logic, and an end-to-end Bridge -> push -> gateway -> viewer run.
- UI without Telegram: serve the gateway locally and open `http://127.0.0.1:8787/?mock` —
  built-in example data, no API call. Mock rendering is not fleet acceptance.
- Live acceptance needs the real chain: a daemon with `fleetGateway` set, the gateway behind
  https, the app opened from that bridge bot on each client in use (Android, iOS, Desktop),
  a Topic link tapped.

## Failure isolation and rollback

- The push is a timer in the daemon, at most one in flight, 5 s timeout, never awaited by
  Telegram routing; a failing gateway logs once (`fleet gateway: push failed (...)`) and the
  bridge carries on.
- Roll back a host: remove `bridge.fleetGateway` (either layer). Roll back the gateway: stop
  it. Revert the code: the change is additive — `fleetSnapshot()`, the push timer, the config
  key, the new files — nothing else in the bridge changed.

## Known limits (V0.1)

- Polling (8 s UI, `everySeconds` push), no SSE; offline detection lags by up to `ttlSeconds`.
- Single viewer role: every allowlisted user sees every host.
- No gateway service installer; run it under your process manager of choice.
- Ended sessions vanish from the next push rather than lingering as `Ended`.
