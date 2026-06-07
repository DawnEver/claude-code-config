# Sharp Review

Plugin: `cc-market/sharp-review/`. Stop hook (`hooks/sharp-review-hook.js`) classifies review depth (none/once/triple) and delegates to `/sharp-review` skill. State stored in unified `.claude/.rem-state.json` under `reviewGate` key.

## Provider config
`classify()` reads the active provider env vars — no hardcoded `api.anthropic.com`. Falls back to `mode: 'once'` if model or key missing.

## Review execution
Skill launches 3 parallel plain Claude agents (no agentType). Schema must be `{ type: 'object', properties: { findings: [...] } }` — bare array schema causes silent StructuredOutput failure. Pass `{ diff, date }` as workflow args (date required; `Date.now()` banned in workflow scripts).

## Task system & Rem integration
- `cc-market/rem/scripts/task-engine.js` — core task engine (owned by rem): generates tasks.md, archives resolved, updates MEMORY.md. Takes `--findings <json-file>`, `--check`, `--report`.
- `cc-market/sharp-review/scripts/post-review.js` — writes workflow result as single memory entry (`.claude/memory/YYYY-MM-DD/sharp-review.md`) with rem frontmatter → delegates to rem engine
- Findings live in a single file per session: `.claude/memory/YYYY-MM-DD/sharp-review.md` — rem-managed lifecycle: stamp → touch → promote → compact → evict
- Finding IDs: `SR-YYYYMMDD-NNN`; categories: Bug/Feature/Performance
- Scale: <10 open → flat list; 10-50 → sectioned; 50+ → split files
- MEMORY.md has a dedicated `## Tasks` section above short-term memory
- **Resolving findings:** edit `**Status:** OPEN` → `**Status:** FIXED` directly in the memory file
- **User-facing skill:** `/todo` — view, add, sync, resolve tasks
- **Memory cross-reference:** SR-IDs written back to related memory files via `[[SR-ID]]` wiki-links by `post-review.js`

## Full lifecycle
1. Sharp review → `.claude/memory/YYYY-MM-DD/sharp-review.md` with rem frontmatter
2. `stamp-memory.js` → indexes in MEMORY.md
3. `rem-prep.js` → scans transcript for SR-IDs, bumps `accessed`, suggests promotion
4. Session stop → `/rem` compacts if needed
5. `prune-memory.js` → evicts stale short-term entries (90d); promoted long-term entries protected
6. Archive → resolved findings moved to `tasks/archive/`
