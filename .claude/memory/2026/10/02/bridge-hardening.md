---
name: bridge-hardening
description: Session-bridge hardening and live verification (2026-10-02)
---

# Session bridge: hardening pass (2026-10-02)

## Fleet onboarding
- `private-markers` (the public-hygiene denylist) now rides the sync payload as an OPTIONAL
  `~/.claude` link (`base: 'sync', optional: true` in `CLAUDE_LINKS`); never in git.
  doctor WARNs `private-markers-missing` on a sync-dir host without it, and `bridge-host`
  when the fleet runs a bridge but this host has no bot token.
- README "Adding a host to the fleet": clone outside sync -> `setup --sync-dir ... --machine <NAME>`
  -> local secrets + own bot -> `npm run doctor` clean of those WARNs.

## Routing and noise
- Observer reports a push only into the ONE owning session Topic on that branch; several
  sessions -> narrow by the pushing agent (committer provenance); still ambiguous -> drop.
- `lanes` Topic and `coordinator` REMOVED: they duplicated the forge's own notifications
  (single source of truth). Issues and repo activity are read on the forge.
- Mirrored posts are silent (`disable_notification`). Approvals and failed turns alert and
  mention each `allowedUserIds` user by id (`text_mention`, shown as `@you`), which pierces a
  muted chat. Claude's `StopFailure` hook (API error ending a turn) -> failed final -> alert.
- `channel-<pid>.log` pruned after 7 days at channel start.
- Windows `bridge:install` now stops the running daemon first; before, the new daemon refused
  to start beside the old one, so new code never ran until the next logon.

## /clear
`/clear` changes BOTH ids the hook reports (payload `session_id` and `CLAUDE_CODE_SESSION_ID`),
so mirrors matched no channel. On a miss the hook retries with its nearest `claude` process
(process-table walk, `scripts/shared/process-tree.mjs`; slow, so only on a miss); the channel
registers under that pid. Never `CLAUDE_PID`: a nested `claude` inherits its parent's.

## Live status
- Verified: inbound into a closed Topic, channels + `--remote-control`, Telegram approval
  buttons, `deleteForumTopic`, mirroring after `/clear`.
- Unverified: stale-button behaviour, `@you` through a muted chat, the 24 h auto sweep,
  `StopFailure` live.
- Open: in one session Write/`rm` approvals were not relayed to Telegram while WebFetch ones
  were — cause unknown (no prompt shown vs. Claude not relaying those kinds).
