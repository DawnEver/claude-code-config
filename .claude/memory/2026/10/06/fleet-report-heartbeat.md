---
name: fleet-report-heartbeat
description: Why the fleet report looked silent, and the always/registered-session changes
---
# Fleet report heartbeat (2026-10-06)

Symptom: no periodic fleet post. Cause: rounds ran hourly (fleet-report.json `round`
advancing) but `renderReport` returned null — a host block needed a Working/Needs-*
session, an actionable reset or a seat problem; `messageId: null` is the tell.

Changes (fd7f03a, e09bee8, not pushed at time of writing):
- `bridge.fleet.always: {claude, codex}` — default `{claude: true, codex: false}`: a host
  with quota data reports every round even with no session. No shared-config entry needed.
- Every registered (non-ended) session now counts as running, Idle/Unknown included,
  listed with its state. So a registered Codex session shows Codex even with always.codex off.

Deploy: each host pulls and restarts the bridge daemon (ensure.mjs on next session start).
