---
name: dashboard-recovery-and-codex-liveness
description: Dashboard off because shared bridge.dashboard was missing; read quota alerts; Codex stale-thread liveness fix; other hosts onboarding
---

# Dashboard recovery, read alerts, Codex liveness (2026-10-18)

## Dashboard was off
- Daemon logged `dashboard: off (bridge.dashboard.url missing or not a URL)`. The shared payload
  `claude_env_settings.json` (OneDrive sync dir) had no `bridge.dashboard` block at all — the file
  was dated before the dashboard shipped. Restored from the user's copy (adds `dashboard` with 6
  hosts and `alerts`, drops retired `fleet`). Bak files removed afterwards at the user's request.
- Check a host's token: `sha256(local bridge.dashboard.hostToken) === shared hosts[machine]`.
  A successful push logs nothing; only `off`/`push failed` lines appear.

## Read quota alerts (dashboard)
- `alertKey(q)` = account key | verdict | binding window | resetsAt (`public/view.mjs`).
  `quotaAlerts(snapshot, now, read)` and `tabs(..., read)` exclude read keys.
- `app.js`: tapping a needs-you quota row marks it read in `localStorage`
  (`dashboard.readAlerts`); keys pruned to standing alerts only when `snapshot.accounts` exists.
- Review fixes applied: `Array.isArray` guard on the parsed value; save in the click handler.
  Remaining review notes (unescaped `|`, unguarded store.set, bind-undefined key) are in today's
  `sharp-review.md`.

## Codex liveness (`scripts/bridge/codex-adapter.mjs`)
- Cause: Codex keeps a thread loaded while ANY client subscribes and exposes no subscriber info;
  the bridge's own `thread/resume` subscription pinned old VS Code threads loaded forever, so
  dashboard showed Topic-less idle/Unknown Codex rows. `ThreadStatus` = notLoaded|idle|systemError|active.
- Live probe (thread/loaded/list + thread/read): `01a13545` systemError, `01a13a10` idle for
  hours, both vscode source in one project.
- Fix: `systemError` -> `#abandon` (unsubscribe, down, add to `errored`; re-subscribed only when
  `thread/read` shows recovery). Idle >= 10 min -> `thread/unsubscribe`, keep the session; if still
  loaded 60 s later another client holds it -> re-resume silently (no `up`), replay
  `backlogSince(turns, releasedAt)`. Unloaded -> normal `down`.
- After restart 01a13545 no longer registers; 01a13a10 release unconfirmed at time of writing.

## Onboarding other hosts
pull repo; `machine.json` name must match `hosts`; if no local `hostToken`, run
`npm run dashboard -- host-token`, put the printed hash into shared `hosts`, then
`npm run dashboard -- deploy` (Worker reads hosts only from deploy-time `DASHBOARD_CONFIG`);
restart daemon via `ensure.mjs`. `botToken`/`set-menu` is per bot, done once anywhere.

## Open
- All changes uncommitted; Worker not redeployed with read-alerts.
