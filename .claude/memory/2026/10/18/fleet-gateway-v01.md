---
name: fleet-gateway-v01
description: Agents Dashboard V0.1 (read-only Telegram Mini App) — current design, deployment, lessons, open items
---

# Agents Dashboard V0.1 (2026-10-18)

Usage/authority: `docs/dashboard.md`. Code: `scripts/dashboard/`.

## Current design
- Gateway = Cloudflare Worker + one `DashboardHub` Durable Object (registry in memory),
  deployed as `agents-dashboard` on the user's own domain via `scripts/dashboard/deploy.mjs`
  (`npm run dashboard -- host-token | deploy | set-menu`). The earlier Node `server.mjs` and the
  HMAC initData path are removed; the first Worker (`agent-fleet`) was deleted.
- Own dashboard bot (control plane belongs to no workstation). initData verified by Telegram's
  Ed25519 third-party signature: needs only `botId` + Telegram's public key (checked verbatim
  against core.telegram.org/bots/webapps.md), never a bot token in the cloud.
- `api.mjs` = routes on Web-standard Request/Response, so Node tests drive it directly.
- Config single home: shared `bridge.dashboard` {url (origin), botId, everySeconds, hosts:
  {machine: sha256}}. Secrets local-only: `hostToken` (push), `botToken` (read by `set-menu`,
  which also reads the button back). Neither reaches the Worker's `DASHBOARD_CONFIG`.
- Bridge side unchanged in shape: `Bridge.dashboardSnapshot()` (read-only projection),
  `dashboard-push.mjs` off the message path, `scripts/shared/dashboard-schema.mjs` wire contract.
- Rename: everything of the Mini App is "dashboard". The Telegram fleet REPORT (`fleet.mjs`,
  `bridge.fleet`, `fleetSessions`) keeps its name — a different feature.
- UI: needs-you summary card first, status chips with counts, one section per host (online
  first, offline dimmed), sessions sorted by urgency, chevron only when a Topic opens.

## Lessons
- An apostrophe inside a single-quoted string made `app.js` a syntax error: the page only showed
  "Loading..." forever. A test now runs `node --check` on every public script.
- A zombie `wrangler dev` (workerd) from an earlier run held the port and faked later failures:
  check the port owner before trusting a local result.
- `.dev.vars` values must be unquoted JSON (quoted values keep the escapes).
- Campus DNS cached NXDOMAIN for 30 min (SOA minimum) after the first lookup of a new
  subdomain; `ipconfig /flushdns` needs elevation. Probe via `--resolve` against 1.1.1.1's answer.
- Headless Chrome on Windows clips screenshots below ~500 px width: not a layout overflow.

## Open
- User must save `bridge.dashboard.botToken` locally, then `set-menu` (menu still points at the
  deleted first Worker's address).
- Telegram client acceptance (open Dashboard, tap a Topic link); second host onboarding.
- Commits 41aa4f7, 9a0602f, c1baa8c unpushed.
