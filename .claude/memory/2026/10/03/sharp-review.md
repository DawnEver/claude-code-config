---
name: sharp-review-2026-10-03
description: Sharp review findings — 3 total
metadata:
  type: project
---

## Review 2026-10-03 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261003-001] [MEDIUM] scripts/bridge/daemon.mjs — Moving machine to the end hides the field that tells two hosts' Topics apart

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Cap the branch at a fixed width (e.g. 40) so machine and agent stay visible.

Project prefix is constant within a per-project group; long branches push machine/agent past the visible part of truncated titles on mobile.

---

### [SR-20261003-002] [MEDIUM] scripts/bridge/daemon.mjs — Old-format titles are only migrated for sessions that reconnect; dormant and closed Topics keep the old order forever

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a one-time rename pass at startup, or document the behavior in docs/bridge.md.

Rename happens only in the session-up path, so a forum ends up with titles in both formats.

---

### [SR-20261003-003] [LOW] scripts/bridge/daemon.mjs — A failed rename puts the legacy title back with a single warning; the retry path has no test

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a test for a rename that throws; log every failed rename.

Failures after the first are warned only once (warnOnce), and old titles go into the uniqueness set.
