# AGENTS.md

## Setup
- `npm run setup` - Initial setup
- `node scripts/setup.js` - Manual setup
- Re-run setup to verify (checks existing symlinks)

## Architecture
Cross-platform Claude Code & Codex config sync: centralizes in OneDrive, links to `~/.claude/` and `~/.codex/`.

### Structure
- `scripts/`: `setup.js` (OS detection, symlinks), `notify.js` (cross-platform notifications), `cc.js` (provider launcher)
- `scripts/shell/`: `aliases.sh`, `aliases.ps1` (legacy; wrappers now installed alongside `claude`)
- `claude_plugins/`: Custom plugins (e.g., `claude-hud`)
- `claude_settings.json`: Env vars, permissions, hooks (gitignored, secrets not tracked)
- `claude_settings.template.json`: Template for new clones — auto-copied to `claude_settings.json` by setup
- `claude_env_settings.json`: API keys per provider (gitignored, secrets not tracked)
- `claude_env_settings.template.json`: Desensitized provider template — auto-copied to `claude_env_settings.json` by setup
- `GLOBAL-AGENTS.md`: Global guidelines

### Provider Switching
- `cc` — launch Claude Code with official Claude Pro subscription (clears all provider env vars)
- `ccds` — launch Claude Code via DeepSeek API (reads `claude_env_settings.json`)
- Add providers by editing `claude_env_settings.json` (use `claude_env_settings.template.json` as reference)
- Wrappers installed alongside `claude` executable; available in CMD, PowerShell, and Git Bash

### Workflows
- Hooks in `claude_settings.json` trigger `notify.js` for `TaskCompleted`, `PostToolUseFailure`, `Notification`
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
