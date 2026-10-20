---
name: dashboard-reset-and-packed-layout
description: Dashboard quota reset countdown per window, alert identity, packed layout toggle, open gaps
metadata:
  type: project
---
# Dashboard: reset countdown, alert identity, packed layout (2026-10-20)

Code: `scripts/dashboard/public/{app.js,view.mjs,index.html}` (uncommitted, undeployed at session end).

## Done
- Reset countdown is a per-window cell (`resetCell`, `↻ 4h 20m`) beside the window's `used%`,
  same weight, collapsed and expanded: its ONE place on a quota row. Row warn line uses
  `verdictText(q, now, false)` (no reset); alerts/events keep the reset.
- Needs-you quota alert rows show email + `on <hosts>`, then the verdict.
- Config > This device: "Packed layout" (localStorage `dashboard.packed`, toggles `body.packed`):
  `#hosts` and quota hosts become CSS columns (`break-inside: avoid`) instead of aligned grid rows.
  Order then runs down columns, not across.
- Telegram Web/Desktop Mini App window size cannot be set by the page; `tg.expand()` only affects
  mobile. Only `requestFullscreen()` (Bot API 8.0) exists — offered as an optional toggle, not built.

## Open
- SR-20261020-014: `.qmini` 4th auto column can squeeze the bar to zero width in 120px cells.
- SR-20261020-015: `resetCell` can show `↻ 0m` for an unrefreshed passed reset.
- `sharp-review.md` 2026-10-20 holds 13 foreign pyproject findings (SR-001..013) from a stale
  raw.json — verify/remove.
- Proposed gaps: per-host "best account now" line; one card per shared account; consistent
  left/used unit + mark binding window; plain wording for no data/new/≤/≥; staleness as styling;
  session wait time; project grouping; pre-exhaustion alerts; visible mark-read; legend on touch;
  three-level type scale.
