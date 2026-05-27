# Claude Code & Codex Cross-Platform Configuration Sync

Sync Claude Code and Codex configuration files across multiple devices via OneDrive to maintain a consistent development environment.

## Prerequisites

### Nodejs

Please refer to https://nodejs.org/en/download

## Installation

### Claude Code

Please refer to https://code.claude.com/docs/en/setup

```sh
npm install -g @anthropic-ai/claude-code
```

### Codex

- https://github.com/openai/codex-plugin-cc

```sh
npm install -g @openai/codex
codex login
```


### LSPs

```sh
npm install -g pyright
npm install -g typescript-language-server typescript
rustup component add rust-analyzer
```

#### TypeScript / Pyright LSP on Windows

On Windows, `uv_spawn` cannot find binaries without the `.cmd` extension ([#1432](https://github.com/anthropics/claude-plugins-official/issues/1432)).
`setup.js` automatically patches `marketplace.json` to append `.cmd` to `typescript-language-server` and `pyright-langserver` — no manual edits needed.

## Setup

### Basic Setup

Run the setup script to configure symbolic links:

```sh
node scripts/setup/setup.js
```

Or replace existing files:

```sh
node scripts/setup/setup.js --replace
```

### How It Works

This script auto-detects the OneDrive source directory and creates symbolic links in `~/.claude/` and `~/.codex/`. Works on macOS, Windows, and Linux. Run it again to verify existing links — it won't overwrite files.

### Configuration

If `claude_settings.json` doesn't exist (it's gitignored to protect secrets), setup automatically copies `claude_settings.template.json` → `claude_settings.json`. Edit your local `claude_settings.json` with your API key and personal config.

If `claude_env_settings.json` doesn't exist, setup copies `claude_env_settings.template.json` → `claude_env_settings.json`. Fill in your API keys for each provider.

### Provider Switching

Setup installs `cc` and `ccds` wrappers alongside the `claude` executable, available in CMD, PowerShell, and Git Bash:

```sh
cc      # Claude Pro — official subscription (no API key required)
ccds    # DeepSeek API — reads claude_env_settings.json
```

To add more providers, add an `env:<name>` block to `claude_env_settings.json` (see `claude_env_settings.template.json`) and add an alias entry in `scripts/setup/setup.js`.

### Troubleshooting

**Windows Permissions:** If you get a privilege error, enable Developer Mode in Windows Settings or run as Administrator.

**Note:** Sometimes modifying files in `~/.claude/` directory may require administrator privileges.

## Hooks

Claude Code hooks automate actions on lifecycle events. All hook scripts live in `scripts/hooks/` and are configured in `claude_settings.json`.

### Hook Overview

| Hook Event | Script | Purpose |
|---|---|---|
| `Notification` | `notify-hook.js` | Native OS notification on all notification events |
| `Stop` | `sharp-review-hook.js` | Post-task sharp review — critique decisions and quality |
| `Stop` | `retrospect-hook.js` | Post-task retrospect — summarize what was done, validate changes, update `.claude/rules` and `.claude/memory` |
| StatusLine | `hud-hook.js` | Terminal status line via [claude-hud](https://github.com/jarrodwatts/claude-hud) |

The retrospect hook gates on session depth: after 3 stop attempts and 2 minutes of work, it blocks the stop (exit 2) to require a retrospective. Lightweight sessions (doc-only changes, few stops) get a shorter prompt. State tracked in `.claude/.retro_state.json`.

### How Hooks Are Wired

In `claude_settings.json`, the `hooks` object maps hook events to arrays of matchers, each containing a list of command hooks:

```json
"hooks": {
  "Notification": [{
    "hooks": [{
      "type": "command",
      "command": "node ~/.claude/scripts/hooks/notify-hook.js"
    }]
  }],
  "Stop": [{
    "hooks": [
      {
        "type": "command",
        "command": "node ~/.claude/scripts/hooks/sharp-review-hook.js",
        "timeout": 30
      },
      {
        "type": "command",
        "command": "node ~/.claude/scripts/hooks/retrospect-hook.js",
        "timeout": 10
      }
    ]
  }]
}
```

The `StatusLine` is configured separately via the `statusLine` field:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/scripts/hooks/hud-hook.js"
}
```

Multiple hooks can run on the same event (e.g., both `sharp-review-hook.js` and `retrospect-hook.js` fire on `Stop`). Each hook's `timeout` (in seconds) limits how long it can run.

### Adding a New Hook

1. Create the hook script in `scripts/hooks/`
2. Add a `hooks` entry in `claude_settings.json` under the desired event
3. If adding a new provider-specific hook, also add an allow permission for the script

## Notifications

Claude Code hooks drive cross-platform system notifications with click-to-open VS Code.

### How It Works

`scripts/hooks/notify-hook.js` is triggered by `Notification` and `Stop` hooks defined in `claude_settings.json`. It sends native OS notifications and supports clicking to jump to VS Code at the workspace:

| Platform | Method | Click to open VS Code |
|----------|--------|-----------------------|
| **macOS** | `osascript` (fallback) or `terminal-notifier` | Requires `brew install terminal-notifier` |
| **Windows** | PowerShell toast with `activationType="protocol"` | Works out of the box |
| **Linux** | `notify-send` + `dbus-monitor` | Works on DEs with D-Bus notification actions |

### macOS Setup

Install `terminal-notifier` for click-to-open support:

```sh
brew install terminal-notifier
```

Without it, notifications still display but clicking won't open VS Code.

Note: make sure to grant notification permissions in System Settings → Notifications for the terminal or notification helper (e.g. terminal-notifier) so click actions will be allowed.

### Testing Notifications

Test notification using:

```sh
claude --bare --model haiku "please read ~/.claude/models.md to test claude permission system [Expected waiting for user's input]"
```

## Memory & Rules

Claude Code's memory system uses two tiers within each project's `.claude/` directory:

| Directory | Purpose | When loaded |
|---|---|---|
| `.claude/rules/` | `MEMORY.md` index + distilled rule files from compact | Auto-loaded every session |
| `.claude/memory/` | Append-only archive: all raw memory files with date prefixes | Loaded on demand via the index |

### How It Works

`@.claude/rules/MEMORY.md` is referenced from `GLOBAL-AGENTS.md`, so Claude loads the index every session. The index lists every file in `.claude/memory/` with a one-line summary. When a situation matches a memory topic, Claude reads the relevant file from `.claude/memory/` on demand.

### Git Tracking

Both directories are tracked in git. The `.gitignore` uses `.claude/*` with `!.claude/rules/` and `!.claude/memory/` exceptions to keep other `.claude/` contents (settings, worktrees) private.

### Adding New Memory

After a session:
1. Write the content file in `.claude/memory/YYYY-MM-DD/<topic>.md`
2. Prepend a one-line entry to `.claude/rules/MEMORY.md` (dates sorted newest-first)
3. Keep at most **20 entries** — drop the oldest when adding new ones

### Memory Compact

When MEMORY.md reaches 20 entries, the retrospect hook triggers a **compact**:

1. Read all files in `.claude/memory/`
2. Distill durable insights into `.claude/rules/` rule files (one per topic)
3. Update any outdated rules
4. Clear `.claude/rules/MEMORY.md` (reset index, keep header)

**Append-only rule:** `.claude/memory/` files are **never deleted**. The compact only clears the index — the raw memory archive is permanent.

## Remote Control
Remove environment variables below to enable remote control(Need Claude Subscribtion):
```json
"DISABLE_TELEMETRY": "1",
"DO_NOT_TRACK": "1",
```
