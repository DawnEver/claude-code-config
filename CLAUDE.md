# CLAUDE.md

## Setup
- `npm run setup` - Initial setup
- `node scripts/setup.js` - Manual setup
- Re-run setup to verify (checks existing symlinks)

## Architecture
Cross-platform Claude Code config sync: centralizes in OneDrive, links to `~/.claude/`.

### Structure
- `scripts/`: `setup.js` (OS detection, symlinks), `notify.cjs` (cross-platform notifications)
- `plugins/`: Custom plugins (e.g., `claude-hud`)
- `settings.json`: Env vars, permissions, hooks (gitignored, secrets not tracked)
- `settings.template.json`: Template for new clones — auto-copied to `settings.json` by setup
- `models.md`: LLM model registry
- `GLOBAL-CLAUDE.md`: Global guidelines
- `vscode-extension/claude-notifications/`: VS Code extension for in-editor notifications

### Workflows
- Hooks in `settings.json` trigger `notify.cjs` for `TaskCompleted`, `PostToolUseFailure`, `Notification`
- `~/.claude/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
- After modifying `vscode-extension/claude-notifications/src/extension.ts`, run `npm run compile` in that directory to rebuild `dist/extension.js`
