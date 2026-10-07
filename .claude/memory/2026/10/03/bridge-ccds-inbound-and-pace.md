---
name: bridge-ccds-inbound-and-pace
description: Fleet quota pace marker; ccds cannot receive channel messages (verified live); Stop-hook queue fallback for channel-less Claude sessions
---
# Fleet pace marker

Revised 2026-10-07: pace = elapsed/window as %, computed at render time (`paceAt(v, now)` in
fleet.mjs) — it depends only on the clock, so it never goes stale, and it matches the
resets countdown in the same row. (Snapshot-time pace showed 55% beside a "1d 20h" reset
that implied 74%.) Stale `used` is a lower bound, so comparing it to the current pace is sound.
The 10-cell bar inserts `┃` between cells (11 chars) instead of overlaying one, so the marker
never hides fill (100% used read as 90%). Stale snapshots (> STALE_MS) raise no run-out warning.

# ccds and channels (verified live, 2026-10-03)

Claude Code drops `notifications/claude/channel` on a third-party provider (ccds, API-key
auth) even with `--dangerously-load-development-channels server:session-bridge`. Adding the
flag to ccds in cc-launcher.mjs was tried and reverted. Outbound mirroring still works
(hooks need no channel); Remote Control also unavailable (claude.ai login). cods works
(Codex app-server, any provider).

# Stop-hook delivery fallback (uncommitted at time of writing)

- server.mjs: `thirdParty = Boolean(ANTHROPIC_BASE_URL)`; `inbound = !thirdParty && flag`.
- claude-adapter.mjs: `inject` on `!inbound` queues `{text,user}` and returns
  `{queued, note}` (reason differs: third-party vs missing flag; busy vs idle wording).
  A `final` mirror (not StopFailure) returns `deliver` and marks the continuation a
  Telegram turn (humanTurn/remoteTurn, running).
- bridge-hook.js `deliverOutput`: Stop prints `{decision:'block', reason:'Message from Telegram (u):\n...'}`.
- daemon.mjs posts the note to the Topic.
- Limitation: an idle session fires no hook, so queued messages wait for a local turn.
- Tests: 86 pass across bridge-hook, claude-adapter, daemon, server. Live check needs a
  daemon restart and a fresh ccds session (old channel server keeps old code).
