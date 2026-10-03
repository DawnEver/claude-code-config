---
name: fleet-quota-and-bridge-noise
description: Bridge noise decisions (no push mirroring, lazy topics) and research on per-seat quota sources for a Telegram fleet card
---
# Decisions (user, 2026-10-03)

- Telegram must NOT mirror pushes or lab/gate verdicts: git and the forge own that.
  Plan: delete `scripts/bridge/observer.mjs`, its test, `docs/coordination.md`, daemon
  wiring (`notify`, `observedSessions`, poll timer) and `observeIntervalSeconds`.
  Not done yet: the auto-mode classifier denied the `git rm`; awaiting user approval.
- Empty session currently emits ~5 Telegram messages (topic created, `session up`, status
  card, pin notice, `session ended` + close). Plan: create the Topic lazily on first real
  activity, drop `session up`, make the status card the first message (auto-pinned), and
  end by editing the card instead of posting. Principle: events are messages, state is edits.

# Fleet model

Quota unit is a SEAT = account email x Team org (Max 5x), each with its own weekly reset;
workstations (one <machine> name each) map to seats. The registry holds
emails, so it lives in the sync dir (optional payload, e.g. `fleet.json`), never in git
(public-hygiene). Manual "reset available <date>" notes are registry annotations.

# Data sources (Claude Code 2.1.288, codex-cli 0.159.3)

- Claude: statusLine stdin `rate_limits.five_hour|seven_day {used_percentage, resets_at}`
  (subscribers only, after first API response; claude-hud already reads it). Identity:
  `~/.claude.json` `oauthAccount` (`emailAddress`, `organizationUuid`, `organizationName`,
  `seatTier`). Only fresh while a session renders; show sample age when idle.
- Codex app-server: `account/rateLimits/read` + `account/rateLimits/updated`
  (primary ~300 min, secondary 10080 min; `usedPercent`, `resetsAt`), `account/read`
  (email, planType; no org id). codex-adapter uses none yet.
- Rejected: undocumented `api.anthropic.com/api/oauth/usage` (token handling, no contract).

# Planned order

1. Remove observer + session-message noise reduction. 2. Seat registry + doctor
wrong-org check. 3. Fleet Topic card (workstations/tasks, then Codex quota, then Claude
quota via hud-hook -> daemon IPC), alerts only on transitions (ETA < reset, org mismatch,
seat on unregistered machine).

# Outcome (same day)

Shipped: 9f72b15 (observer removed), dda339d (lazy Topics, card-first, end = card edit),
9a8d0a5 + 51025f0 (fleet card). Design chosen over a cross-machine aggregator: each
daemon edits its OWN card in `bridge.fleet.chatId[/topicId]` — no leader, no shared
mutable state. Pace = average since window open as of the snapshot (stateless); stale
(>15 min) snapshots never alert. Claude org names differ from what people call them
(organizationName carries a prefix), hence substring `org` or exact `orgUuid`.
Live on <machine>: card shows Claude 5h/7d, Codex 7d (Codex reports only the weekly
window for that plan), seat note, busy tasks. Other hosts pick it up after pull + a
session start (ensure.mjs replaces a daemon whose source fingerprint changed).
