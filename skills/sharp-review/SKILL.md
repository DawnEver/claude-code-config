---
name: sharp-review
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

### Parallel Review — Takeover + Claude Code

For higher-confidence reviews, run two reviews in parallel and cross-check:

1. **Launch takeover review** — hand off the branch diff to another model:
   ```
   /takeover:continue --provider deepseek review this branch diff for bugs, design issues, and dead code. Be blunt.
   ```
2. **Meanwhile, in Claude Code** — run the standard Phase 1 sharp review against the same diff.
3. **When both return** — compare findings. Overlapping issues are high-confidence; unique findings from either side are worth a closer look.
4. Resolve any disagreements before proceeding to Phase 2.

This pattern gives you a second opinion without slowing down the main review flow — both run concurrently.

## Phase 2 — Task Supervision

If Codex tasks are still in flight after the review:

1. Check task status immediately via `TaskGet`.
2. If not done, send a follow-up nudge; re-check in a few minutes.
3. Do **not** mark the feature complete until the task output is verified.

## Usage

Run `/sharp-review` after finishing a feature. No arguments needed — context comes from the current branch diff.
