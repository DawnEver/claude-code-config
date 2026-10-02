---
name: Topic display naming and runtime status proposal
description: Derived project labels and stable session suffixes; one native-evidence-driven status card proposed.
metadata:
  type: implementation
---

# Topic naming implemented

Format: machine | project | branch | host. Project display drops a trailing studio
or lab separated by space/hyphen/underscore. Routing still uses the complete origin
repo name; no new alias configuration or renamed project identity is introduced.
Only concurrent live title collisions add a stable session-key hash suffix, starting
at six hex characters. Reconnect preserves that derived suffix; ended cache records
do not consume counters. Bounded title generation preserves host/suffix, and transport
rejects oversized names rather than silently truncating away identity.

Reattached old active Topics are renamed in place, retaining Topic ID and session
routing. Inactive historical Topics are not bulk rewritten. Rename acknowledgement
and live-session checks gate cache updates. User authorized these group-side changes.

Full suite before commit: 424 tests, 419 pass, zero failures, five existing skips.
Focused review caught complete-title length and session-ending-during-rename hazards;
length bounds and post-await identity guards address them. Public hygiene passes.

# Runtime status proposal (not implemented)

One editable status card per Topic, not a stream of shell/tool details. Native session
events provide running, idle, waiting-approval and disconnected states where known;
the card is a derived view, not a second agent lifecycle authority. Include host,
last native event time, evidence source and refresh button. Stop button is offered
only for hosts with a verified native interrupt capability (currently Codex).

Existing /status is already on-demand, but Codex reports an opaque active turn ID and
Claude only knows whether its channel is connected. A channel connection is NOT proof
that Claude is idle or progressing. Claude activity inferred from hooks must be labelled
as inferred/unknown, with native signal gaps visible. Avoid fabricated percent complete,
elapsed-time heuristics declaring hangs, or per-second remote polling.

Next iteration: TDD native event -> status projection -> one card update, callback
sender/chat/topic/message checks, restart/reconnect recovery and stale event isolation.
Reuse Bridge routing and native adapter status; no new daemon, database or permission
control plane. Commit naming independently before implementing this proposed UX.
