# REM Hook

## Mid-task interruption guards
The Stop hook checks `hasPendingWork = background_tasks.length > 0 || now < taskActiveUntil` before firing `/rem`.

- `background_tasks`: async subagents (codex, takeover) — provided by Claude Code
- `taskActiveUntil`: sequential multi-round skills — set explicitly in `.claude/.rem_state.json`

## Setting taskActiveUntil
```bash
node -e "
const s=JSON.parse(require('fs').readFileSync('.claude/.rem_state.json','utf8')||'{}');
s.taskActiveUntil = Date.now() + 30*60*1000;
require('fs').writeFileSync('.claude/.rem_state.json',JSON.stringify(s,null,2));
"
```

Auto-expires after 30 min. Clear with `delete s.taskActiveUntil` when done.

## Known issues → see `.claude/memory/` for current unfixed issues
