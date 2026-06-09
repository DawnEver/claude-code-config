---
name: sharp-review-2026-06-08
description: Sharp review findings — 25 total
metadata:
  type: project
created: 2026-06-08
accessed: 2026-06-08
tier: short
---




## Review 2026-06-08 (session) — current branch

### Reviewer Status
- Reviewer A (Codex, via takeover): OK
- Reviewer B (DeepSeek, via takeover): OK
- Reviewer C (Claude, native): OK

### Confirmed findings

---

### [SR-20260604-001] [HIGH] .claude/rules/MEMORY.md — Bulk MEMORY.md wipe: 20 short-term entries deleted as collateral

- **Category:** Bug
- **Module:** memory index
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Use surgical Edit targeting specific lines rather than replacing multi-line blocks when removing index entries

Commit 9b3bc06 intended to remove 3 plugin-specific entries but wiped all 20 short-term entries + the Active Tasks link. Fixed by 7369e94.

---

### [SR-20260604-002] [HIGH] cc-market/rem/scripts/stamp-memory.js — Truncated date bug: all stamp-memory.js output uses `[2026 name]` not `[2026-06-08 name]`

- **Category:** Bug
- **Module:** REM memory stamping
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fix extractDateFromPath call site — relPath is likely computed relative to wrong base, stripping the MM/DD components before the function sees it

---

### [SR-20260604-003] [MEDIUM] .claude/rules/MEMORY.md — Active Tasks link missing from Tasks section after wipe

- **Category:** Bug
- **Module:** memory index
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed inline — restored link to tasks.md

---

### [SR-20260604-004] [MEDIUM] .claude/memory/ — Plugin-internal memory written to main repo scope

- **Category:** Feature
- **Module:** memory scoping
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Always check AGENTS.md scoped-memory section before writing memory about plugin internals

---

### [SR-20260604-006] [MEDIUM] cc-market/rem/scripts/stamp-memory.js — Date truncation bug deferred indefinitely — accumulates silently

- **Category:** Bug
- **Module:** rem / stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fix and backfill in the next rem-focused session; the fix is small per the bug analysis

---

### [SR-20260604-009] [INFO] cc-market/takeover — model-selection bug affects DeepSeek/Claude API paths; codex path unaffected

- **Category:** Bug
- **Module:** takeover
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: resolveModel() now maps 'sonnet'/'opus'/'haiku' tier names to provider-specific model names via TIER_MAP; cc-market commit e163bca


## Review 2026-06-08 (follow-up) — stamp-memory.js fixes

### Reviewer Status
- Reviewer A (Codex, via takeover): OK
- Reviewer B (DeepSeek, via takeover): OK
- Reviewer C (Claude, native): OK

### Confirmed findings

---

### [SR-20260608-001] [MEDIUM] .claude/rules/MEMORY.md — Memory index re-adds previously-evicted entries without validation

- **Category:** Bug
- **Module:** rem / memory index
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Confirmed entries were genuinely lost by wipe (commit 9b3bc06), re-addition was correct recovery

---

### [SR-20260608-002] [MEDIUM] .claude/memory/2026/06/08/sharp-review.md — Findings marked FIXED with no corroborating commit or linked evidence

- **Category:** Bug
- **Module:** sharp review / memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Resolved: stamp-memory.js fixes → cc-market commit 725e115; task-engine fixes → cc-market commit (this session); structural fixes → main repo commits ddf2b11, e232cc6

---

### [SR-20260608-003] [LOW] .claude/memory/2026/06/08/sharp-review.md — SR-20260608-003 label misleading — takeover model bug scope clarified, not fixed

- **Category:** Bug
- **Module:** takeover
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Status corrected to OPEN with codex-unaffected note

---

### [SR-20260608-004] [LOW] .claude/rules/MEMORY.md — Mixed label formats in scoped entries

- **Category:** Bug
- **Module:** rem / memory index
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: removed malformed entries; stamp-memory.js corrects these on re-index

---

### [SR-20260608-005] [MEDIUM] rem/scripts/stamp-memory.js — Malformed entries silently retained alongside re-added correct duplicates

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: rebuild block uses parseIndexEntry/formatIndexEntry, drops malformed lines

---

### [SR-20260608-006] [MEDIUM] rem/scripts/stamp-memory.js — entryRe and entryPattern were separate duplicate regex definitions

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: consolidated to parseIndexEntry/formatIndexEntry from lib.mjs

---

### [SR-20260608-007] [LOW] rem/scripts/stamp-memory.js — Comment said malformed entries re-added 'on next run' — actually same run

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed inline

---

### [SR-20260608-008] [LOW] rem/.claude/memory/2026/06/08/stamp-memory-truncated-date-bug.md — Memory entry documented bug as unfixed with stale warning

- **Category:** Feature
- **Module:** rem memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: memory entry updated to document root cause resolved

---

### [SR-20260608-009] [HIGH] rem/scripts/stamp-memory.js — Malformed index entries produce duplicates on every stamp-memory run

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: malformed entries excluded from existingPaths, dropped in rebuild, re-added correctly

---

### [SR-20260608-010] [MEDIUM] rem/scripts/stamp-memory.js — Index rebuild stripped Tasks section items

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: headerLines filter now scoped to date-structured paths only

---

### [SR-20260608-011] [LOW] rem/lib.mjs — extractDateFromPath silently falls back to mtime/today

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: added console.warn on fallback path

---

## Review 2026-06-08 (follow-up) — memory bookkeeping + task engine

### Reviewer Status
- Reviewer A (Codex, via takeover): OK
- Reviewer B (DeepSeek, via takeover): OK
- Reviewer C (Claude, native): OK

### Confirmed findings

---

### [SR-20260608-101] [HIGH] .claude/memory/tasks/tasks.md — Task count inflated by likely-resolved entries; task-engine should auto-close FIXED findings

- **Category:** Bug
- **Module:** task engine
- **Status:** FIXED
- **Confidence:** high-confidence (≥2 reviewers)
- **Suggestion:** Fixed: task-engine.js status comparisons now case-insensitive — FIXED findings are archived and excluded from open count

---

### [SR-20260608-102] [HIGH] .claude/memory/tasks/tasks.md — Tasks marked FIXED in memory remain OPEN in tasks.md

- **Category:** Bug
- **Module:** task engine
- **Status:** FIXED
- **Confidence:** high-confidence (≥2 reviewers)
- **Suggestion:** Fixed: all status checks normalized to lowercase — `'FIXED'.toLowerCase() === 'fixed'` now correctly archives and closes tasks

---

### [SR-20260608-103] [HIGH] .claude/memory/tasks/tasks.md — SR-20260604-001 through -007 dropped from active list without archive entries

- **Category:** Bug
- **Module:** task engine
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: TASK_LINE_RE now matches `(undefined)` dates; parseExistingTasks tracks section headers to preserve module; mergePreserved uses entry.module

---

### [SR-20260608-104] [MEDIUM] .claude/rules/MEMORY.md — Scoped section placed before Short-term entries after stamp-memory rebuild

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** high-confidence (≥2 reviewers)
- **Suggestion:** Fixed: restored correct order; stamp-memory.js section ordering needs enforcement

---

### [SR-20260608-105] [MEDIUM] .claude/memory/2026/06/08/sharp-review.md — Duplicate session header '## Review 2026-06-08 (session)' appears twice

- **Category:** Bug
- **Module:** sharp review / memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: collapsed duplicate headers; renamed second section to '(follow-up) — stamp-memory.js fixes'

---

### [SR-20260608-106] [MEDIUM] .claude/memory/2026/06/08/sharp-review.md — SR-20260608-006 and SR-20260608-012 are duplicate findings

- **Category:** Bug
- **Module:** sharp review
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: removed SR-20260608-012 from this file; SR-20260608-006 is the canonical finding

---

### [SR-20260608-107] [LOW] .claude/memory/2026/06/08/sharp-review.md — Extra blank line after frontmatter

- **Category:** Bug
- **Module:** stamp-memory
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed inline

---

### [SR-20260608-108] [LOW] .claude/memory/tasks/tasks.md — SR-20260604-009 listed under 'unknown' module

- **Category:** Bug
- **Module:** task engine
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fixed: parseExistingTasks now tracks current `### module` section header; mergePreserved uses entry.module instead of hardcoded 'unknown'


### Resolved: task-engine fixes (round 3)

All findings from round 3 resolved. task-engine.js fixed for case-sensitive status, undefined-date preservation, and module attribution.

### Resolved: takeover model-selection fix

All findings resolved. takeover resolveModel() now maps tier names to provider-specific models.
