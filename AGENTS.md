# AGENTS.md

## Setup
- `npm run setup` - Initial setup
- `node scripts/setup/setup.js` - Manual setup
- Re-run setup to verify (checks existing symlinks)

## Architecture
Cross-platform Claude Code & Codex config sync: centralizes in OneDrive, links to `~/.claude/` and `~/.codex/`.

### Structure
- `scripts/setup/`: `setup.js` (OS detection, symlinks)\n- `scripts/runtime/`: `cc.js` (provider launcher), `aliases.sh`, `aliases.ps1`\n- `scripts/hooks/`: `notify-hook.js` (cross-platform notifications), `hud-hook.js`, `retrospect-hook.js`, `sharp-review-hook.js`
- `skills/`: Custom Claude Code skills — symlinked to `~/.claude/skills`. Add new skills here as `skills/<name>/SKILL.md`; they are picked up automatically.
- `claude_plugins/`: Custom plugins (e.g., `claude-hud`)
- `cc-market/`: Community plugin marketplace (gitignored, cloned by setup) �?provides `takeover` for multi-model orchestration
- `claude_settings.json`: Env vars, permissions, hooks (gitignored, secrets not tracked)
- `claude_settings.template.json`: Template for new clones �?auto-copied to `claude_settings.json` by setup
- `claude_env_settings.json`: API keys per provider (gitignored, secrets not tracked)
- `claude_env_settings.template.json`: Desensitized provider template �?auto-copied to `claude_env_settings.json` by setup
- `keybindings.json`: Claude Code keybindings �?synced to `~/.claude/keybindings.json`
- `GLOBAL-AGENTS.md`: Global guidelines

### Provider Switching
- `cc` �?launch Claude Code with official Claude Pro subscription (clears all provider env vars)
- `ccds` �?launch Claude Code via DeepSeek API (reads `claude_env_settings.json`)
- Add providers by editing `claude_env_settings.json` (use `claude_env_settings.template.json` as reference)
- Wrappers installed alongside `claude` executable; available in CMD, PowerShell, and Git Bash

### Workflows
- Hooks in `claude_settings.json` trigger `notify-hook.js` for `TaskCompleted`, `PostToolUseFailure`, `Notification`
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
