---
name: bridge-ccds-inbound-and-pace
description: Fleet quota pace marker; ccds cannot receive channel messages (verified live); Stop-hook queue fallback for channel-less Claude sessions
---
# Fleet pace marker

`windowView` (scripts/bridge/fleet.mjs) now returns `pace` = elapsed/window as %, computed
at snapshot time (`at`), so it stays comparable to `used` even on stale data. The quota
table column is `used / pace`; the 10-cell bar overlays `┃` at the pace cell (fill past
it = spending faster than an even rate). Same 10% band hides the order; numbers disambiguate.

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
