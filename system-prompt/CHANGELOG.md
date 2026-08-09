# System Prompt CHANGELOG — official-update absorption log

## How to absorb an official change (SOP)

1. Update the Piebald clone and run the radar:
   `git -C <piebald> pull && node system-prompt/sync-official.mjs --repo <piebald>`
2. Review the new list in this file: check the box `[ ]` → `[x]` for parts you
   decide to absorb, leave unchecked what we deliberately drop (memory system,
   insights, artifact comments, coordinator, etc. — the audit list in
   cc-lab/reports/system-prompt-audit.md records the clean set).
3. For each absorbed part, edit the owning file:
   - universal principle/preference → `GLOBAL-AGENTS.md`
   - claude platform behavior (tools/delegation/notifications) → `system-prompt/claude-base.md`
   - codex platform → `system-prompt/codex-base.md`
4. Verify cache health: `node system-prompt/validate-cache.mjs system-prompt/claude-base.md [--tools <list>]` — run 2 must be ≈ all cache_read.
5. Rebuild styles: `node system-prompt/build.mjs`
6. Run tests: `npm test` (Sync/claude) + fabric suite.
7. Commit in Sync/claude (prompt files + this log), then commit the fabric
   memory entry in cc-market/fabric if the behavior contract changed.

Nothing auto-merges. The full-replacement design keeps runtime immune to
official prompt updates — absorption is a deliberate, human decision.

