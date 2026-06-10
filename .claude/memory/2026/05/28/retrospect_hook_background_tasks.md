---
name: retrospect-hook-background-tasks
description: Stop hook background_tasks guard — prevents mid-flight interruption of async subagents
metadata:
  type: project
created: 2026-05-28
accessed: 2026-06-10
tier: long
access_count: 2
---

## retrospect-hook: background_tasks fix (2026-05-28)

### What changed
Added `background_tasks` guard in `scripts/hooks/retrospect-hook.js` before the deny gate.  
When `input.background_tasks` is non-empty, hook returns allow without advancing state — prevents mid-flight interruption of sharp-review, takeover, and codex workflows.

### Why
Stop hook fires on every turn end, not just true session end. Multi-round skills that spawn background tasks (codex, takeover subagents) were getting interrupted between rounds.

### Known follow-up items
1. **State carryover bug**: `retroPending` leaks across sessions within the 30-min window when `input.session_id` is null — session ID check silently skips. Fix: treat null session ID as always-different.
2. **Sequential multi-round tasks**: `background_tasks` won't help if a skill does all rounds in a single Claude turn without spawning background tasks.
