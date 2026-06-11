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
- `npm run migrate` - Bring `~/.claude`/`~/.codex` symlinks and the current project's `.claude/` (cc-market plugin files) up to the latest format. `npm run migrate -- --dry-run` previews orphaned-symlink removal only. See `/migrate` skill.

## Architecture
Cross-platform Claude Code & Codex config sync: centralizes in OneDrive, links to `~/.claude/` and `~/.codex/`.

### Structure
- `scripts/setup/`: `setup.js` (OS detection, symlinks)
- `skills/migrate/`: `/migrate` skill — `migrate.js` (orphaned symlink cleanup + cc-market plugin `.claude/` migrations) and tests
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
- `.claude/memory/`: Historical reference with `MEMORY.md` index (git-tracked); on-demand loading, `created`/`accessed` timestamps, managed by `rem` plugin. Findings stored as `sharp-review.md` per session — sole source of truth for tasks.
- `.claude/workflows/`: Saved workflow scripts (symlinked from repo; sharp-review workflow now in `cc-market/sharp-review/workflows/`)

### CLI Tools
- `cc` / `ccds` — Claude Code launchers (official / DeepSeek), config in `claude_env_settings.json`
- `todo` — Task management: `todo` (list), `todo <text>` (add), `todo rm <id>` (remove), `todo help`
- `traceme` — Personal observability: token/cost reports, multi-device sync
- `aliases.ps1` / `aliases.sh` — Shell integration; `setup.js` installs `.cmd` wrappers on Windows

### Workflows
- Hooks in `claude_settings.json` trigger `notify-hook.js` for `TaskCompleted`, `PostToolUseFailure`, `Notification`
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
- Plugin development, tests, and marketplace conventions → see `cc-market/AGENTS.md`
- This repo is publicly available, but it is primarily intended for personal use and rapid iteration — backward compatibility is not a concern. Rename, restructure, or remove anything outdated rather than adding shims or compat layers.
