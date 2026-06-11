---
name: task-system
description: Sharp-review + rem task integration — sync-tasks.js engine, 3-tier scale, archive mechanism, workflow+schema enforcement
metadata:
  type: project
---

# Task System (sharp-review + rem integration)

## Architecture
- `scripts/sync-tasks.js` — engine: scans `.claude/sharp-review/` + `.claude/memory/`, rebuilds task list, archives resolved items, detects scale
- `.claude/memory/tasks/tasks.md` — active task dashboard (progressive disclosure via MEMORY.md)
- `.claude/memory/tasks/archive/YYYY-MM.md` — monthly resolved-task buckets, 90d eviction
- `.claude/workflows/sharp-review.js` — 3 parallel reviewers with JSON Schema enforcement
- `skills/sharp-review/SKILL.md` — thin wrapper: gather diff → workflow → write → sync

## Scale tiers
- Small (< 10 open): tasks.md with module headers, bugs only
- Medium (10-50): tasks.md with Features/Bugs/Performance sections + module sub-groups
- Large (50+): tasks/ directory (features.md, bugs.md, perf.md)

## Finding format
- Stable IDs: `SR-YYYYMMDD-NNN` assigned at review time
- Structured metadata: Category (Bug/Feature/Performance), Module, Status, Suggestion
- Workflow enforces via JSON Schema — `enum` on severity/category, `required` fields

## Lifecycle
1. `/sharp-review` → workflow spawns 3 reviewers → returns structured findings → writes markdown → syncs tasks
2. Resolved tasks → moved to archive/YYYY-MM.md → 90d eviction via rem prune
3. Stale tasks (> 90d untouched) → flagged, reviewed during REM
4. MEMORY.md has dedicated `## Tasks` section separate from Short-term memory

## Persistent resolution (FIXED 2026-06-04)
- `.claude/sharp-review/resolved.txt` — permanent resolved-ID store (survives re-sync)
- `--resolve SR-xxx` CLI flag persists to resolved.txt
- Checked boxes in tasks.md auto-promote to resolved.txt on next sync
- **Critical bug fix**: `generateSmall/Medium/Large` all now receive `resolvedIds` param and pass it to `mergePreserved()` — without this, `mergePreserved` re-added preserved entries (unchecked, from the old tasks.md) even if they were in resolved.txt
