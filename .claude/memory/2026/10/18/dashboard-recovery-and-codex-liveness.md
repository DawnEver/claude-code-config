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
- Codex keeps a thread loaded while ANY client subscribes, exposes no subscriber info, and
  keeps an unsubscribed thread loaded for an undocumented while (measured: still loaded 350 s
  after the last unsubscribe). `ThreadStatus` = notLoaded|idle|systemError|active.
- The bridge's own subscription pinned closed windows' threads forever. A first fix re-held
  released threads after a 60 s grace: a guess shorter than Codex's delay, so it pinned them again.
- Fix: `systemError` -> abandon (unsubscribe, down, `errored` until thread/read shows recovery).
  Idle >= 10 min -> unsubscribe, keep the session, watch with `thread/read` (no subscription);
  take it back only when active or `updatedAt` advanced (replay `backlogSince(turns, releasedAt)`);
  down when Codex unloads it. No timer guesses.
- Probing: `thread/resume` on a thread a TUI holds fails "already has an active writer"; a probe
  that resumes an old thread loads it and it shows on the dashboard until Codex unloads it.

## Daemon applies changes itself
Every minute the daemon compares its startup config and source revisions; on a change it spawns
`ensure.mjs`, which replaces it. Replaced the partial live reload (a few keys, dashboard-on only)
and `DashboardPush.every`. Hosts no longer wait for a session start after a sync or pull.

## Worker state
`events` and `alerted` persist in the Durable Object's `ctx.storage.kv` (Registry `store`);
memory-only state wiped the history and re-alerted standing conditions on every deploy.
Telegram quota alerts and `bridge.alerts` are removed: events live only in the dashboard.

## Onboarding hosts
`npm run dashboard -- host-token` (after `npx wrangler login`) writes the local token, the shared
`hosts` hash and deploys. doctor `dashboard-host` FAILs on token/hash mismatch or a missing shared
block. Code deploys from CI (`.github/workflows/dashboard-deploy.yml`, tests gate it).
