---
name: fleet-gateway-v01
description: Telegram Fleet Mini App V0.1 (read-only) — design decisions, verification, open items
---

# Fleet gateway + Mini App V0.1 (2026-10-18, commit d6d46dd, not pushed)

Usage/authority: `docs/fleet-gateway.md`.

## Design decisions
- Zero dependencies, no build: `node:http` gateway, vanilla ES-module Mini App
  (`scripts/fleet-gateway/public/`; pure logic in `view.mjs`, DOM in `app.js`, textContent only).
  Rejected the plan's React/Vite/Tailwind/Fastify: the repo has no npm deps.
- Export = `Bridge.fleetSnapshot()`: read-only projection of the existing registry + adapter
  `statusSnapshot`. No new state, no log parsing. `fleetSessions()` (fleet report) now derives from it.
- One status vocabulary: `STATUS_CODES` (native -> code) -> `STATUS_LABELS` (code -> text), used by
  status card, fleet report and wire; test cross-checks against `STATUSES`.
- Wire contract + trust boundary: `scripts/shared/fleet-schema.mjs` (`parseHostPush` whitelists
  fields; Topic link `t.me/c/<id>/<topicId>` derived there; raw chat id never served). Lives in
  shared so `bridgeSourceRevision` needs no gateway dir.
- `fleet-push.mjs`: own unref'd timer, one in flight, 5 s timeout, never on the Telegram path;
  `accepted:false` counts as failure; failures logged once.
- Ordering: `bootAt` (daemon start) + `seq`; gateway refuses older boot / earlier tick and a boot
  > 5 min ahead of its clock. Freshness (`stale`, gateway clock) separate from status.
- `bridge.fleetGateway.hostToken` read from the local layer only; config errors surface as
  `fleetGatewayError` logged by the daemon. URL must be an origin.
- Per user: NO new bot. Gateway runs on one bridge workstation and reuses that machine's
  `botToken` + `allowedUserIds` via `readBridgeConfig` (initData is signed by the bot that opens
  the app). `~/.claude/fleet-gateway.json` holds only host token hashes + listener.

## Verification
- Real host: this workstation's daemon pushed its 2 real sessions to a loopback gateway (config temporarily
  edited, restored byte-identical). After restart Claude sessions read Unknown until next hook edge.
- 219 bridge+gateway tests pass. Full suite: 12 failures identical to baseline (symlink EPERM, pre-existing).
- Two reviews (diff reviewer + sharp-review 32 findings) fixed; see sharp-review.md same day.

## Open (need user)
- HTTPS tunnel: none installed (tailscale/cloudflared/ngrok/caddy absent); choose method.
- Choose gateway workstation; Telegram client acceptance (open app, tap Topic links per client).
- Multi-host verification; no gateway service installer; `daemon.mjs` >600 lines split deferred
  (plan forbids core daemon rework in this phase).
