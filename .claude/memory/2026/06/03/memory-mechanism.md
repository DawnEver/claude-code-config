---
name: memory-mechanism
description: Three-tier loading system (rules→AGENTS.md→memory) with created/accessed timestamps and 90-day eviction policy
metadata:
  type: project
created: 2026-06-03
accessed: 2026-06-03
tier: short
---

## Three-tier loading

| Tier | When loaded | Content |
|---|---|---|
| `.claude/rules/*.md` | Always injected | Actionable behavioral constraints, progressive disclosure |
| `AGENTS.md` | Always injected | Architecture overview |
| `.claude/memory/` | On-demand (model reads) | Detailed reference with timestamps |

## Memory conventions

- Every file has `created` + `accessed` in frontmatter (ISO YYYY-MM-DD)
- `created` = parent folder date; `accessed` = last active reference
- `scripts/touch-memory.js <path>` — bump `accessed` when a memory is read
- `scripts/setup/stamp-memory.js` — batch-add timestamps to all files

## Eviction policy

- `accessed > 90 days` → candidate for archival/deletion
- If content has been extracted to a rule → safe to remove
- MEMORY.md index capped at 20 entries
- `.claude/memory/` is append-only — never delete memory files, only clear index entries

## Rules trimming convention

Rules use progressive disclosure: short pointer → memory for details.
Example: `## Known bugs → see .claude/memory/ for current unfixed issues`
This replaced verbose bug lists in api-proxy, notify-hook, and retrospect-hook rules.
