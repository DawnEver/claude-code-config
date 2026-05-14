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
/codex:setup --enable-review-gate
```


### LSPs

```sh
npm install -g pyright
npm install -g typescript-language-server typescript
rustup component add rust-analyzer
```

#### Troubleshooting: TypeScript LSP on Windows

**Issue:** typescript-lsp plugin fails on Windows — uv_spawn cannot find binary without .cmd extension

**Reference:** https://github.com/anthropics/claude-plugins-official/issues/1432

**Solution:** Manually edit `~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json` and change:

```json
"command": "typescript-language-server"
```

to:

```json
"command": "typescript-language-server.cmd"
```

**Note:** Same question for pyright; rust-analyzer does not need .cmd extension

## Setup

### Basic Setup

Run the setup script to configure symbolic links:

```sh
node scripts/setup.js
```

Or replace existing files:

```sh
node scripts/setup.js --replace
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

To add more providers, add an `env:<name>` block to `claude_env_settings.json` (see `claude_env_settings.template.json`) and add an alias entry in `scripts/setup.js`.

### Troubleshooting

**Windows Permissions:** If you get a privilege error, enable Developer Mode in Windows Settings or run as Administrator.

**Note:** Sometimes modifying files in `~/.claude/` directory may require administrator privileges.

## Notifications

Claude Code hooks drive cross-platform system notifications with click-to-open VS Code.

### How It Works

`scripts/notify.js` is triggered by `Stop` and `Notification` hooks defined in `claude_settings.json`. It sends native OS notifications and supports clicking to jump to VS Code at the workspace:

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

## Remote Control
Remove environment variables below to enable remote control(Need Claude Subscribtion):
```json
"DISABLE_TELEMETRY": "1",
"DO_NOT_TRACK": "1",
```