---
name: feedback_skills_location
description: "All new skills and agents belong in the repo's skills/ directory, symlinked to ~/.claude/skills — never in ~/.claude/plugins/cache or elsewhere"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2007c28a-2bde-485d-9e8f-3e92612b025f
created: 2026-05-27
accessed: 2026-06-10
tier: short
access_count: 1
---

All custom skills and agents must be placed in the repo at `skills/<name>/SKILL.md` (i.e., `C:\Users\linxu\OneDrive - The University of Nottingham\Sync\claude\skills\`), which is symlinked to `~/.claude/skills`.

**Why:** Skills live in the repo so they are version-controlled, synced across machines via OneDrive, and survive cache clears. The symlink `~/.claude/skills → repo/skills/` is created by `setup.js`.

**How to apply:** Whenever creating or modifying a skill or agent skill file, write it to `skills/<name>/SKILL.md` in the repo — never directly into `~/.claude/` or `~/.claude/plugins/cache/`.
