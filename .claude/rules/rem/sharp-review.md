# Sharp Review

Plugin: `cc-market/sharp-review/`. Stop hook (`hooks/sharp-review-hook.js`) classifies review depth (none/once/triple) and delegates to `/sharp-review` skill. State stored in unified `.claude/.rem-state.json` under `reviewGate` key.

## Provider config
`classify()` reads the active provider env vars — no hardcoded `api.anthropic.com`. Falls back to `mode: 'once'` if model or key missing.

## Review execution
Skill launches 3 parallel plain Claude agents (no agentType). Schema must be `{ type: 'object', properties: { findings: [...] } }` — bare array schema causes silent StructuredOutput failure. Pass `{ diff, date }` as workflow args (date required; `Date.now()` banned in workflow scripts).

## Task system & Rem integration
- `cc-market/sharp-review/scripts/sync-tasks.js` — bridges findings into `.claude/memory/tasks/tasks.md`; archive at `.claude/memory/tasks/archive/YYYY-MM.md`
- HIGH/MEDIUM findings → individual memory files at `.claude/memory/YYYY-MM-DD/SR-YYYYMMDD-NNN.md` with full frontmatter (rem-managed lifecycle: touch → promote → compact → evict)
- Finding IDs: `SR-YYYYMMDD-NNN`; categories: Bug/Feature/Performance
- Scale: <10 open → flat list; 10-50 → sectioned; 50+ → split files
- MEMORY.md has a dedicated `## Tasks` section above short-term memory
- **Resolving findings:** `node cc-market/sharp-review/scripts/sync-tasks.js --resolve SR-YYYYMMDD-NNN ...`
- **Memory cross-reference:** SR-IDs written back to memory files via `[[SR-ID]]` wiki-links; `rem-prep.js` auto-touches referenced findings; `compact.js` suggests resolution when findings distilled into rules

## Full lifecycle
1. Sharp review → finding with `[[SR-ID]]` in memory file
2. `rem-prep.js` → scans transcript for SR-IDs, bumps `accessed`, suggests promotion
3. Session stop → `/rem` compacts if needed; compacted findings → auto-resolve suggestion
4. `prune-memory.js` → evicts stale short-term findings (90d); promoted long-term findings protected
5. Archive → resolved findings moved to `tasks/archive/`; memory files preserved (append-only)
