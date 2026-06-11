---
name: retrospect-hook-task-guard
description: taskActiveUntil convention for multi-round sequential skills
metadata:
  type: project
---

# Retrospect Hook — Multi-round Task Guard

## Convention: `taskActiveUntil` in `.retro_state.json`

Skills that orchestrate multiple sequential rounds (no background tasks) MUST set `taskActiveUntil` so the retrospect hook doesn't fire mid-task.

**At the start of a multi-round skill:**
```bash
node -e "
const f='.claude/.retro_state.json';
const s=JSON.parse(require('fs').readFileSync(f,'utf8') || '{}');
s.taskActiveUntil = Date.now() + 30*60*1000;
require('fs').writeFileSync(f, JSON.stringify(s, null, 2));
"
```

**At the end (or on error), clear it:**
```bash
node -e "
const f='.claude/.retro_state.json';
const s=JSON.parse(require('fs').readFileSync(f,'utf8') || '{}');
delete s.taskActiveUntil;
require('fs').writeFileSync(f, JSON.stringify(s, null, 2));
"
```

## How the hook uses it

`hasPendingWork = background_tasks.length > 0 || now < taskActiveUntil`

- `background_tasks`: async tasks (codex, takeover subagents) — provided by Claude Code
- `taskActiveUntil`: sequential multi-round tasks — set explicitly by the skill

Auto-expires after 30 min even if the skill crashes. Field lives in the existing `.claude/.retro_state.json`, no extra files.
