---
name: dashboard-bot-token-live
description: Dashboard alerts are live — bot token uploaded, offline exclusion list, hostToken vs botToken
---
# Dashboard alerts live (2026-11-06, commit 8088b1e)

- `bridge.dashboard.botToken` (local layer, from @BotFather for the dashboard bot = shared
  `botId`) is NOT `hostToken` (this host's push credential). Deployed from this machine: the
  Worker now holds DASHBOARD_BOT_TOKEN; a test message reached the allowed user's private chat.
- Shared `bridge.dashboard.offlineAlertExclude` (set to the laptop that sleeps) — those hosts are
  never alerted offline; redeploy after editing it.
- A Worker without DASHBOARD_BOT_TOKEN does not sweep, so no host is marked alerted for an unsent alert.
- First Worker-originated alert not yet observed.
