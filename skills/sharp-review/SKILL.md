---
name: sharp-review
description: Post-feature Codex sharp review (锐评) — critique decisions, redundancy, and quality; then supervise any in-flight Codex tasks until confirmed done.
---

# Codex Review & Supervision

## Output Rule

**Write ALL findings to `.claude/sharp-review/YYYY-MM-DD.md` (append to today's file).** Chat output is ONE summary line only: total issue count + file path. Do NOT dump findings in chat.

## Phase 1 — Sharp Review (锐评)

Run **at least 2 of the 3** reviewers below in parallel. All three cover the same surface:

- Bad architectural or design decisions
- Redundant / dead code
- Anything simpler, faster, or more idiomatic
- Missed edge cases or silent failures

Tone: blunt. Praise nothing that doesn't deserve it.

### Reviewer A — Codex `adversarial-review`

Always available (built-in). Launch via the Codex **`adversarial-review`** command (read-only, no file writes) on the current branch diff. It already carries the review contract — do not substitute `rescue`.

### Reviewer B — Takeover DeepSeek (deepseek-v4-pro)

The takeover agent auto-gathers context (git diff, files) before calling the remote model. Just give it the task:

```
/takeover:continue --provider deepseek --model deepseek-v4-pro Review the current branch git diff for: bad design/architecture, redundant/dead code, simpler alternatives, edge cases, silent failures. Be BLUNT. Output each finding as [severity] file — issue → suggestion.
```

### Reviewer C — Takeover Sonnet (Claude)

```
/takeover:continue --provider claude Review the current branch git diff for: bad design/architecture, redundant/dead code, simpler alternatives, edge cases, silent failures. Be BLUNT. Output each finding as [severity] file — issue → suggestion.
```

### Execution & Cross-Check

1. **Launch all available in parallel** — Codex, takeover deepseek, takeover claude. Minimum two must run; prefer all three.
2. **When all return** — compare and merge findings:
   - Issues found by ≥2 reviewers → **high-confidence**.
   - Issues found by only 1 reviewer → still valid, just not corroborated. Treat them the same.
3. **Write merged findings to `.claude/sharp-review/YYYY-MM-DD.md`** (create dir if needed, append with `## Review <timestamp>` header).
4. **Apply fixes** for all confirmed findings immediately.
5. Resolve any disagreements before proceeding to Phase 2.
6. **Output in chat ONLY**: `Sharp review: N issues → .claude/sharp-review/YYYY-MM-DD.md`

## Phase 2 — Task Supervision

If Codex tasks are still in flight after the review:

1. Check task status immediately via `TaskGet`.
2. If not done, send a follow-up nudge; re-check in a few minutes.
3. Do **not** mark the feature complete until the task output is verified.

## Usage

Run `/sharp-review` after finishing a feature. No arguments needed — context comes from the current branch diff.
