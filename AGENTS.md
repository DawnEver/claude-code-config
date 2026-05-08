# AGENTS.md

## Setup
- `npm run setup` - Initial setup
- `node scripts/setup.js` - Manual setup
- Re-run setup to verify (checks existing symlinks)

## Architecture
Cross-platform Claude Code & Codex config sync: centralizes in OneDrive, links to `~/.claude/` and `~/.codex/`.

### Structure
- `scripts/`: `setup.js` (OS detection, symlinks), `notify.js` (cross-platform notifications)
- `claude_plugins/`: Custom plugins (e.g., `claude-hud`)
- `claude_settings.json`: Env vars, permissions, hooks (gitignored, secrets not tracked)
- `claude_settings.template.json`: Template for new clones — auto-copied to `claude_settings.json` by setup
- `models.md`: LLM model registry
- `GLOBAL-AGENTS.md`: Global guidelines
- `vscode-extension/claude-notifications/`: VS Code extension for in-editor notifications

### Workflows
- Hooks in `claude_settings.json` trigger `notify.js` for `TaskCompleted`, `PostToolUseFailure`, `Notification`
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
- After modifying `vscode-extension/claude-notifications/src/extension.ts`, run `npm run compile` in that directory to rebuild `dist/extension.js`
