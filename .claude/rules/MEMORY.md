# Memory Index

<!--
Three-tier memory system:
  1. Rules (.claude/rules/)         — always injected, core behavioral constraints only
  2. Long-term memory (tier: long)  — progressive disclosure, demoted to short if inactive between prune cycles
  3. Short-term memory (tier: short) — progressive disclosure, 90d eviction

Promotion: run `node scripts/touch-memory.js <path> --promote` to upgrade short → long
Demotion:  long-term not accessed between two prune cycles → auto-demoted to short
Prune:     run `node scripts/prune-memory.js --evict-stale` (short-term eviction + long-term demotion check)
Compact:   run `node scripts/compact.js --check` when index grows large

Frontmatter:
  - created:  ISO date (parent folder date)
  - accessed: ISO date (bumped by touch-memory.js on reference)
  - tier:     long | short (default short, promoted via touch-memory.js --promote)
-->

## Tasks (progressive disclosure)

<!-- Task list managed by sync-tasks.js. Load on demand via the index entries below. Completed tasks are archived to memory/tasks/archive/ and evicted after 90d. -->


## Short-term (90d eviction window)


- [2026-06-04 SR-20260604-001](../memory/2026-06-04/SR-20260604-001.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-002](../memory/2026-06-04/SR-20260604-002.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-003](../memory/2026-06-04/SR-20260604-003.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-004](../memory/2026-06-04/SR-20260604-004.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-005](../memory/2026-06-04/SR-20260604-005.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-006](../memory/2026-06-04/SR-20260604-006.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-007](../memory/2026-06-04/SR-20260604-007.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-008](../memory/2026-06-04/SR-20260604-008.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-009](../memory/2026-06-04/SR-20260604-009.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-016](../memory/2026-06-04/SR-20260604-016.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-018](../memory/2026-06-04/SR-20260604-018.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-019](../memory/2026-06-04/SR-20260604-019.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-04 SR-20260604-020](../memory/2026-06-04/SR-20260604-020.md) — `created: 2026-06-04, accessed: 2026-06-06`
- [2026-06-06 SR-20260606-001](../memory/2026-06-06/SR-20260606-001.md) — `created: 2026-06-06, accessed: 2026-06-06`
- [2026-06-04 git-tidy-skill-update](../memory/2026-06-04/git-tidy-skill-update.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-04 takeover-model-bug](../memory/2026-06-04/takeover-model-bug.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-04 task-system](../memory/2026-06-04/task-system.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-04 sharp-review-workflow-bugs](../memory/2026-06-04/sharp-review-workflow-bugs.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-03 takeover-plugin-v2](../memory/2026-06-03/takeover-plugin-v2.md) — `created: 2026-06-03, accessed: 2026-06-03`
- [2026-06-03 update-plugins-hook-removed](../memory/2026-06-03/update-plugins-hook-removed.md) — `created: 2026-06-03, accessed: 2026-06-03`
