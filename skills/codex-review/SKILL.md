---
name: codex-review
description: Post-feature Codex sharp review (锐评) — critique decisions, redundancy, and quality; then supervise any in-flight Codex tasks until confirmed done.
---

# Codex Review & Supervision

## Phase 1 — Sharp Review (锐评)

Use the Codex built-in **`adversarial-review`** command (read-only, no file writes) on the current branch diff. It already carries the review contract — do not substitute `rescue`.

Instruct Codex to surface:
- Bad architectural or design decisions
- Redundant / dead code
- Anything simpler, faster, or more idiomatic
- Missed edge cases or silent failures

Tone: blunt. Praise nothing that doesn't deserve it.

## Phase 2 — Task Supervision

If Codex tasks are still in flight after the review:

1. Check task status immediately via `TaskGet`.
2. If not done, send a follow-up nudge; re-check in a few minutes.
3. Do **not** mark the feature complete until the task output is verified.

## Usage

Run `/codex-review` after finishing a feature. No arguments needed — context comes from the current branch diff.
