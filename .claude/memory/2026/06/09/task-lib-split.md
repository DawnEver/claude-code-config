---
name: task-lib-split
description: task-engine.js split into task-lib.mjs + CLI, archive migrated to YYYY/MM/DD.md, 4 bugs fixed, 52 tests
metadata:
  type: project
created: 2026-06-09
accessed: 2026-06-09
tier: short
---

## Split

- `cc-market/rem/scripts/task-lib.mjs` (296 lines) — pure logic, all exported
- `cc-market/rem/scripts/task-engine.js` (172 lines) — CLI entry, 4 handler functions

## Bugs fixed

1. **mergePreserved re-adding FIXED entries** — now accepts `allIds` parameter; generateSmall/Medium/Large pass all finding IDs so FIXED entries aren't re-added from preserved
2. **parseExistingTasks missed `##` module headers** — only tracked `###`; now tracks `##` first (small format modules), then `###` overrides (medium format sub-modules)
3. **updateMemoryIndex large-scale catSlug included `.md`** — `Object.entries(files)` yields keys like `"bug.md"`; now strips extension before category matching
4. **archiveResolved YYYY-MM.md → YYYY/MM/DD.md** — changed from flat monthly to nested daily, consistent with memory directory structure

## Tests

`cc-market/rem/tests/task-lib.test.mjs` — 52 tests across 13 suites. Full rem suite: 174 pass.

## Archive migration

Migrated from flat `YYYY-MM.md` + old `YYYY/MM.md` to `YYYY/MM/DD.md`:
- `2026/06/04.md` — 22 resolved findings
- `2026/06/06.md` — 4 resolved findings
- `2026/06/08.md` — 25 resolved findings
- `2026/06/09.md` — 6 resolved findings (includes 2 test artifacts to clean)

## Completed

- All old formats removed, archive migrated to `.claude/tasks/archive/YYYY/MM/DD.md`
- `tasks.md` deleted — sharp-review.md is sole source of truth
- `## Tasks` section removed from MEMORY.md — stamp-memory.js sole maintainer
- Cross-reference write-back removed from sharp-review/lib.mjs (circular refs eliminated)
- `--report` scans memory directly, no stale derived files
- `--add` writes to `.claude/memory/YYYY/MM/DD/manual.md` with rem frontmatter
- 35 tests in task-lib.test.mjs, 177 total across rem+sharp-review
