---
name: git-tidy-skill-update
description: git-tidy skill updated — uncommitted changes now always folded in via WIP commit before squash; skill trimmed to 56 lines
metadata:
  type: project
---

Improved `skills/git-tidy/SKILL.md`:

1. **Uncommitted changes fix**: Step 0 now stages a WIP commit (`git add -A && git commit -m "wip: absorb uncommitted changes"`) as a safety net before rebasing. Previously only "asked" and often skipped. Guard added: "Never proceed to Step 1 with a dirty working tree."

2. **Size reduction**: 149 → 56 lines. Removed example block, redundant Key Principles section (merged into Rules), Windows standalone section (one sentence in Step 3).

**Why:** User reported git-tidy often forgot to include uncommitted changes in the squash.
