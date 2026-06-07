# AGENTS.md

<!--
  Boundary: This file covers the config-sync repo ONLY.
  For cc-market plugin development, see cc-market/AGENTS.md.
  Do NOT mix plugin details here.
-->

## Setup
- `npm run setup` - Initial setup
- `node scripts/setup/setup.js` - Manual setup
- Re-run setup to verify (checks existing symlinks)

## Architecture
Cross-platform Claude Code & Codex config sync: centralizes in OneDrive, links to `~/.claude/` and `~/.codex/`.

### Structure
- `scripts/setup/`: `setup.js` (OS detection, symlinks)
- `scripts/runtime/`: `cc.js` (provider launcher), `aliases.sh`, `aliases.ps1`
- `scripts/hooks/`: `notify-hook.js` (cross-platform notifications), `hud-hook.js`
- `cc-market/sharp-review/`: Sharp review plugin — hook, skill, workflow, findings sync (`post-review.js`)
- `cc-market/rem/`: REM plugin — memory lifecycle, task management engine (`task-engine.js`), `/rem` and `/todo` skills
- `skills/`: Custom Claude Code skills — symlinked to `~/.claude/skills`. Add new skills here as `skills/<name>/SKILL.md`; they are picked up automatically.
- `claude_plugins/`: Custom plugins (e.g., `claude-hud`)
- `cc-market/`: Community plugin marketplace (gitignored, cloned by setup) — see `cc-market/AGENTS.md`
- `claude_settings.json`: Env vars, permissions, hooks (gitignored, secrets not tracked)
- `claude_settings.template.json`: Template for new clones -> auto-copied to `claude_settings.json` by setup
- `claude_env_settings.json`: API keys per provider (gitignored, secrets not tracked)
- `claude_env_settings.template.json`: Desensitized provider template -> auto-copied to `claude_env_settings.json` by setup
- `keybindings.json`: Claude Code keybindings -> synced to `~/.claude/keybindings.json`
- `GLOBAL-AGENTS.md`: Global guidelines, NEVER WRITE IN this repo's memory
- `.claude/rules/rem/`: All rules loaded every session (git-tracked), managed by REM plugin lifecycle. `.claude/rules/MEMORY.md` is the index.
- `.claude/memory/`: Historical reference with `MEMORY.md` index (git-tracked); on-demand loading, `created`/`accessed` timestamps, managed by `rem` plugin
- `.claude/memory/tasks/`: Active task list + archive — sharp-review findings bridged into structured TODO with progressive disclosure via MEMORY.md
- `.claude/workflows/`: Saved workflow scripts (symlinked from repo; sharp-review workflow now in `cc-market/sharp-review/workflows/`)

### Provider Switching
- `cc` -> launch Claude Code with official Claude Pro subscription (clears all provider env vars)
- `ccds` -> launch Claude Code via DeepSeek using Foundry mode (`CLAUDE_CODE_USE_FOUNDRY=1`, direct to `api.deepseek.com/anthropic`)
- Add providers by editing `claude_env_settings.json` (use `claude_env_settings.template.json` as reference)
- Wrappers installed alongside `claude` executable; available in CMD, PowerShell, and Git Bash

### Workflows
- Hooks in `claude_settings.json` trigger `notify-hook.js` for `TaskCompleted`, `PostToolUseFailure`, `Notification`
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
- Plugin development, tests, and marketplace conventions → see `cc-market/AGENTS.md`
