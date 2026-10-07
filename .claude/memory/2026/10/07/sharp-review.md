---
name: sharp-review-2026-10-07
description: Sharp review findings — 4 total
metadata:
  type: project
---

## Review 2026-10-07 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261007-001] [HIGH] scripts/bridge/fleet.mjs — Removing the data age hides a dead quota feed: stale numbers render indefinitely and passed resets show 'renewed' with no observation

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a (!) warning or age line past a larger threshold (e.g. 6h); render a passed reset with no newer snapshot as 'renewed (no data since)'/unknown; test multi-day staleness.

A 15-minute-old and a 6-day-old snapshot look identical; after resetsAt all windows read 'renewed' and the headline title is empty, so a dead producer is invisible.

---

### [SR-20261007-002] [MEDIUM] scripts/bridge/fleet.mjs — 'exhausted' from a stale snapshot ignores unscheduled extra resets / spent reset credits tracked elsewhere in the bridge

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Only claim exhausted from a fresh snapshot, or cross-check extra-resets/credits; stale 100% could read '≥100%' / 'was exhausted'.

extra-resets.mjs exists because out-of-band resets happen; the new 32h-old test locks the wrong claim in.

---

### [SR-20261007-003] [LOW] scripts/bridge/fleet.mjs — Headline still picks the binding window via stale ETA projection

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** When stale, skip the short/eta ranking; pick exhausted then highest used.

Inconsistent with 'never projected from'.

---

### [SR-20261007-004] [LOW] scripts/bridge/fleet.mjs — stale/bound declared after headline; mark parameter is needless indirection

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move stale above headline; replace bound with a boolean helper.

Works only because calls happen after module init.
