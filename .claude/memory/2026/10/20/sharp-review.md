---
name: sharp-review-2026-10-20
description: Sharp review findings — 3 total
metadata:
  type: project
---


## Review 2026-10-20 (follow-up)

## Review 2026-10-20 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261020-014] [MEDIUM] scripts/dashboard/public/index.html — In .qmini cells the new 4th column ('auto' reset) leaves the usage bar with zero width

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Raise the qmini minmax floor to about 160px, or put the reset on its own line or row under the bar in mini cells.

qmini tracks minmax(120px,1fr); 22+34+~60 reset+18 gaps = 134px fixed > 120px, so with 3+ windows on a ~340px card the 1fr bar column drops to 0 or overflows.

---

### [SR-20261020-015] [LOW] scripts/dashboard/public/app.js — resetCell shows '↻ 0m' when a window's reset time has passed or is missing

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Return '' (or 'due') when resetsAt is missing or <= now.

Only w.renewed is checked; stale reading with past resetsAt or null resetsAt renders bold '↻ 0m'.

---

### [SR-20261020-016] [LOW] scripts/dashboard/public/view.mjs — New withReset=false branch of verdictText has no test; positional boolean after now is easy to misuse

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add view tests for verdictText(q, now, false) and the default; consider an options object.

No test pins either form; the Telegram alert caller relies on the default.
