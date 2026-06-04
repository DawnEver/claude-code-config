# Sharp Review

`sharp-review-hook.js` (Stop hook) classifies review depth (none/once/triple) and delegates to `/sharp-review` skill.

## Provider config
`classify()` reads the active provider env vars (Foundry/custom/Anthropic) — no hardcoded `api.anthropic.com`. Falls back to `mode: 'once'` if model or key missing.

## Review execution
Skill launches 3 parallel plain Claude agents (no agentType). Schema must be `{ type: 'object', properties: { findings: [...] } }` — bare array schema causes silent StructuredOutput failure. Pass `{ diff, date }` as workflow args (date required; Date.now() banned in workflow scripts).

## Task system
- `scripts/sync-tasks.js` — bridges findings into `.claude/memory/tasks/tasks.md`; archive at `.claude/memory/tasks/archive/YYYY-MM.md`
- Finding IDs: `SR-YYYYMMDD-NNN`; categories: Bug/Feature/Performance; workflow enforces via JSON Schema
- Scale: <10 open → flat list; 10-50 → sectioned; 50+ → split files
- MEMORY.md has a dedicated `## Tasks` section above short-term memory
- **Resolving findings:** `node scripts/sync-tasks.js --resolve SR-YYYYMMDD-NNN ...` — persists to `.claude/sharp-review/resolved.txt`, survives re-sync. Checking `[x]` in tasks.md auto-promotes to resolved.txt on next sync.
