# Memory Index

<!-- Sorted by date, newest first. Keep at most 20 entries. -->

- [2026-05-28 Retrospect hook task guard convention](../memory/2026-05-28/retrospect_hook_task_guard.md) — Set taskActiveUntil in .retro_state.json at start of sequential multi-round skills; auto-expires 30min
- [2026-05-28 Retrospect hook background_tasks fix](../memory/2026-05-28/retrospect_hook_background_tasks.md) — Guard against mid-task interruption using input.background_tasks; session_id leak also fixed
- [2026-05-28 Takeover review fixes](../memory/2026-05-28/project_takeover_review.md) — Architectural invariants after 3-round sharp review: stdin-only prompt delivery, testable callers in lib.mjs, unified Agent dispatch, early --write rejection, retry logic
- [2026-05-27 Git commit: use Bash](../memory/2026-05-27/feedback_git_commit.md) — Always use Bash (not PowerShell) for git commit; PowerShell here-strings leak @ into messages
- [2026-05-27 Skills location](../memory/2026-05-27/feedback_skills_location.md) — All skills/agents go in repo `skills/<name>/SKILL.md`, symlinked to `~/.claude/skills`
