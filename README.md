# Claude Code & Codex Cross-Platform Config Sync

Syncs Claude Code and Codex configuration across devices via OneDrive.

> This repo is publicly available, but it is primarily intended for personal use and rapid iteration — backward compatibility is not a concern. Rename, restructure, or remove anything outdated rather than adding shims or compat layers.

## Prerequisites

- [Node.js](https://nodejs.org/en/download)
- [Claude Code](https://code.claude.com/docs/en/setup): `npm install -g @anthropic-ai/claude-code`
- [Codex](https://github.com/openai/codex-plugin-cc): `npm install -g @openai/codex && codex login`

## Setup

```sh
node scripts/setup/setup.js          # create symlinks
node scripts/setup/setup.js --replace  # overwrite existing files
```

Creates symlinks from `~/.claude/` and `~/.codex/` to this repo. Re-run to verify - won't overwrite.
Claude links `skills/` as one directory. Codex keeps its own `~/.codex/skills`
directory for built-in `.system` skills, so setup links each repo skill from
`./skills/<name>` into `~/.codex/skills/<name>`.

If `claude_settings.json` or `claude_env_settings.json` are missing, setup copies the `.template.json` versions automatically. Fill in your API keys.

### LSPs

```sh
npm install -g pyright typescript-language-server typescript
rustup component add rust-analyzer
```

**Windows:** `setup.js` patches `marketplace.json` to append `.cmd` to LSP binary names (required by `uv_spawn` - [#1432](https://github.com/anthropics/claude-plugins-official/issues/1432)).

### Provider Switching

Setup installs provider wrappers alongside the `claude` executable (CMD, PowerShell, Git Bash):

```sh
ccc   # official Claude subscription
ccds  # DeepSeek API (Foundry mode, direct to api.deepseek.com)
```

Add providers by editing `claude_env_settings.json` (see template) and adding an alias entry in `scripts/setup/setup.js`.

#### Output styles (non-coding personas)

For non-coding work (e.g. academic writing) in the terminal, use an **output
style** rather than the default coding prompt: `output-styles/<name>.md` (synced
and symlinked to `~/.claude/output-styles`). With `keep-coding-instructions:
false` it strips Claude Code's coding guidance while keeping the harness and
tools, so you can switch between coding and writing within one session:

```
/config  → Output style → Academic   # needs /clear or a new session to take effect
```

`output-styles/academic.md` is a scholarly writing/thinking persona. Add more by
dropping a `<name>.md` file in `output-styles/`.

> A full system-prompt replacement (`--system-prompt-file`) was considered and
> rejected: it discards the entire harness and degrades Claude Code into a plain
> chatbox. See `.claude/memory/2026/06/20/persona-vs-output-style.md`.

### VS Code Extension

The VS Code extension spawns its own `claude` process. Configure it separately:

```sh
node scripts/setup/setup-vscode.js deepseek   # switch to DeepSeek
node scripts/setup/setup-vscode.js claude      # revert to official
```

Writes `terminal.integrated.env.*` and `claudeCode.environmentVariables` to local VS Code `settings.json` (and cleans up legacy `claudeCode.claudeProcessWrapper`). Re-run on each machine. Exclude these keys from VS Code Settings Sync to avoid cross-platform conflicts.

### Troubleshooting

**Windows permissions:** Enable Developer Mode or run as Administrator if symlink creation fails.


## Hooks

All hook scripts live in `scripts/hooks/` and are configured in `claude_settings.json`.

| Event | Script | Purpose |
|---|---|---|
| `Notification` | `notify-hook.js` | Native OS notification |
| `Stop` | `sharp-review` plugin | Post-task sharp review (3 parallel reviewers) |
| `statusLine` | `hud-hook.js` | Terminal HUD via [claude-hud](https://github.com/jarrodwatts/claude-hud) |

The `rem` and `sharp-review` plugins (Stop hooks for memory consolidation and code review) are auto-registered via `enabledPlugins` - no manual wiring needed.

The REM hook gates on session depth (鈮? stops, 鈮? min). Runs `/rem` skill. State tracked in `.claude/.rem-state.json`.

Hook wiring in `claude_settings.json`:

```json
"hooks": {
  "Notification": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/hooks/notify-hook.js" }] }]
},
"statusLine": { "type": "command", "command": "node ~/.claude/scripts/hooks/hud-hook.js" }
```

## Notifications

`notify-hook.js` sends native notifications:

| Platform | Method | Sound | Click to open |
|---|---|---|---|
| macOS | `terminal-notifier` (Homebrew) | Built-in notification sound | Not supported (no `-open` flag) |
| Windows | PowerShell toast | Toast audio (`ms-winsoundevent:Notification.Default`) | Works out of the box |
| Linux | `notify-send` + `dbus-monitor` | `paplay` / `aplay` (freedesktop sound theme) | Requires D-Bus |

Sound is **on by default**. Pass `--no-sound` to silence it. By default, clicking the notification does **not** open VS Code. Pass `--open` to enable click-to-open:

```json
"command": "node ~/.claude/scripts/hooks/notify-hook.js --open --no-sound"
```

Test:
```sh
claude --bare --model haiku "please read ~/.claude/CLAUDE.md to test claude permission system [Expected waiting for user's input]"
```

## Memory & Rules

| Directory | Purpose | Loaded |
|---|---|---|
| `.claude/rules/` | `MEMORY.md` index + distilled rule files | Every session |
| `.claude/memory/` | Append-only archive with date prefixes | On demand via index |

`@.claude/rules/MEMORY.md` is auto-loaded by Claude Code as a `.claude/rules/` file each session. When a topic matches, Claude reads the relevant memory file on demand.

After a session, add entries to `.claude/memory/YYYY/MM/DD/<topic>.md` and prepend a one-line pointer to `MEMORY.md` (keep 鈮?0 entries, newest-first). If the session changed project architecture or setup, update `AGENTS.md` too.

When `MEMORY.md` hits 20 entries, the REM hook triggers a **crystallize**: distill all memory into `.claude/rules/` rule files, then clear the index. Memory files are never deleted.

Both directories are git-tracked (`.gitignore` uses `.claude/*` with `!.claude/rules/` and `!.claude/memory/` exceptions).

## Remote Control

To enable remote control (requires Claude subscription), remove these env vars from `claude_settings.json`:

```json
"DISABLE_TELEMETRY": "1",
"DO_NOT_TRACK": "1"
```
