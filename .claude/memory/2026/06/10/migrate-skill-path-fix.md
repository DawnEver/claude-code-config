---
name: migrate-skill-path-fix
description: "/migrate skill invocation simplified to ~/.claude/skills/migrate/migrate.js; compact prefers tier:long promotion over new rules for niche topics"
metadata:
  type: feedback
created: 2026-06-10
accessed: 2026-06-10
tier: short
---

## migrate skill: drop repo-root requirement

`skills/migrate/SKILL.md` previously told users to run
`node "<path-to-this-config-repo>/skills/migrate/migrate.js"`. Since
`~/.claude/skills` is itself a symlink into this repo's `skills/` (via
`setup.js`'s `CLAUDE_LINKS`), the invocation is now:

```bash
node ~/.claude/skills/migrate/migrate.js
```

(PowerShell: `node "$env:USERPROFILE\.claude\skills\migrate\migrate.js"`).
Run from the directory of the project being migrated — `cwd` is what
`discoverProjectMigrators` uses, not where `migrate.js` lives.

## compact: don't distill niche/topic-specific memory into rules

During this session's `/rem` compact pass, 13 short-term entries (git
commit/push conventions, skills location, hook guards, vscode provider
config, model/effort strategy, removed-feature notes, memory-mechanism docs)
were initially distilled into new `.claude/rules/rem/*.md` files.

**User feedback:** these should stay as **long-term memory** (`tier: long`,
promoted via `touch-memory.js --promote`), not become always-injected rules.
`.claude/rules/` is reserved for core behavioral constraints needed every
session (git commit tooling choice, GLOBAL-AGENTS.md boundary already
covered by existing `git-conventions.md`/`global-agents.md`).

**How to apply:** When `/rem` compact finds the index ≥20 entries, default to
promoting individual entries to `tier: long` via `touch-memory.js --promote`
rather than writing new `.claude/rules/rem/<topic>.md` files — only fold into
rules content that's genuinely a per-session behavioral constraint. This may
leave the index >20 even after a "compact" pass; that's acceptable per user
preference.
