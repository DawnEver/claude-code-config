# Skill & Agent File Location

All custom skills and agents belong in this repo at `skills/<name>/SKILL.md`, which is
symlinked to `~/.claude/skills`.

**Why:** Skills live in the repo so they are version-controlled, synced across machines via
OneDrive, and survive cache clears. The symlink `~/.claude/skills → repo/skills/` is created
by `setup.js`.

**How to apply:** Whenever creating or modifying a skill or agent, write it to
`skills/<name>/SKILL.md` in this repo — never directly into `~/.claude/` or
`~/.claude/plugins/cache/`.
