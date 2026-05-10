# Claude Code & Codex Cross-Platform Configuration Sync

Sync Claude Code and Codex configuration files across multiple devices via OneDrive to maintain a consistent development environment.

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
/codex:setup --enable-review-gate
```

### MCPs

```sh
npm install -g @fission-ai/openspec@latest
```
### LSPs & Troubleshoot
```sh
npm install -g pyright
npm install -g typescript-language-server typescript
rustup component add rust-analyzer
```
- typescript-lsp/pyright-langserver plugin fails on Windows — uv_spawn cannot find binary without .cmd extension https://github.com/anthropics/claude-plugins-official/issues/1432
- rust-analyzer do not need .cmd extension

## Setup

```sh
node scripts/setup.js
```

or replace existing files:

```sh
node scripts/setup.js --replace
```

This script auto-detects the OneDrive source directory and creates symbolic links in `~/.claude/` and `~/.codex/`. Works on macOS, Windows, and Linux. Run it again to verify existing links — it won't overwrite files.

If `claude_settings.json` doesn't exist (it's gitignored to protect secrets), setup automatically copies `claude_settings.template.json` → `claude_settings.json`. Edit your local `claude_settings.json` with your API key and personal config.

**Windows note:** If you get a privilege error, enable Developer Mode in Windows Settings or run as Administrator.

## Notifications

Claude Code hooks drive cross-platform system notifications with click-to-open VS Code.

Test notification using:
```sh
claude --bare --model haiku "please read ~/.claude/models.md to test claude permission system [Expected waiting for user's input]"
```
### How it works

`scripts/notify.js` is triggered by `Stop` and `Notification` hooks defined in `claude_settings.json`. It sends native OS notifications and supports clicking to jump to VS Code at the workspace:

| Platform | Method | Click to open VS Code |
|----------|--------|-----------------------|
| **macOS** | `osascript` (fallback) or `terminal-notifier` | Requires `brew install terminal-notifier` |
| **Windows** | PowerShell toast with `activationType="protocol"` | Works out of the box |
| **Linux** | `notify-send` + `dbus-monitor` | Works on DEs with D-Bus notification actions |

### macOS setup

Install `terminal-notifier` for click-to-open support:

```sh
brew install terminal-notifier
```

Without it, notifications still display but clicking won't open VS Code.

Note: make sure to grant notification permissions in System Settings → Notifications for the terminal or notification helper (e.g. terminal-notifier) so click actions will be allowed.

