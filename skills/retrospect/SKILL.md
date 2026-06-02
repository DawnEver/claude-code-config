---
name: retrospect
description: Session retrospective — summarize what changed, update memory, compact if needed
---

# Session Retrospective

Decide depth by checking context:

## Compact (memory index ≥ 20 entries)

If `.claude/rules/MEMORY.md` has 20+ entries:

1. Read all files in `.claude/memory/`
2. Distill durable insights into `.claude/rules/` rule files (one per topic, e.g. git-conventions.md, code-review.md)
3. Update any outdated rules already in `.claude/rules/`
4. After all insights are captured in rules, clear `.claude/rules/MEMORY.md` (keep header line, remove all entries)

Rules:
- `.claude/memory/` is append-only — NEVER delete memory files
- Only clear the MEMORY.md index, not the memory files
- Each rule file should be short, actionable, with "How to apply"

Then continue with the standard retrospective below.

## Lightweight (doc-only or non-code session)

Brief summary only:
- What was done in one sentence
- Skip `.claude/rules/` and `.claude/memory/` updates unless something surprising came up
- Update `AGENTS.md` only if project architecture, directory layout, setup steps, or hook behaviour changed

## Standard

Include:
1. What changed and why
2. How it was validated (tests run, manual checks, edge cases)
3. Any open blockers or follow-up items

Update project memory:
- `.claude/memory/YYYY-MM-DD/` — add/update content files under date directory
- `.claude/rules/MEMORY.md` — prepend new entry; keep at most 20 entries sorted newest-first. Drop the oldest if over 20.

Update project docs if needed:
- `AGENTS.md` — update if project architecture, directory layout, setup steps, or hook behaviour changed this session

See README.md#memory--rules for the distinction.

## Cross-project check

If you modified files in OTHER git repos during this session, you MUST also update their `.claude/memory/` and `.claude/rules/MEMORY.md`. Check your transcript — you know which repos you touched.
