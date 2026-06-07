---
name: feedback-global-agents
description: GLOBAL-AGENTS.md is global config — never modify it; only AGENTS.md is project-specific
metadata:
  type: feedback
created: 2026-05-29
accessed: 2026-05-29
tier: short
---

Never modify `GLOBAL-AGENTS.md` when working in this repo. It is a global config loaded across all projects.

**Why:** GLOBAL-AGENTS.md is symlinked to `~/.claude/CLAUDE.md` and applies everywhere. Editing it would affect every project, not just this one.

**How to apply:** When updating project docs (architecture changes, setup steps, new features), write only to `AGENTS.md`. Never open or edit `GLOBAL-AGENTS.md`.
