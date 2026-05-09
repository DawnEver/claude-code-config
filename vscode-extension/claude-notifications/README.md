# Claude Notifications

Show Claude Code hook notifications inside VS Code with error popups and terminal jump actions.

## Features

- **Error popups** — critical errors show as VS Code `showErrorMessage` popups with jump action.
- **Jump to Claude Code** — each notification can focus the terminal running Claude Code via process tree matching.
- **Output channel** — all events logged to `Claude Notifications` output channel for reference.

## Commands

| Command | Title |
|---------|-------|
| `claudeNotifications.showOutput` | Claude Notifications: Show Output |
| `claudeNotifications.jumpToRecent` | Claude Notifications: Jump to Recent Event |
| `claudeNotifications.clearHistory` | Claude Notifications: Clear History |

## Requirements

Requires the `scripts/notify.js` hook script from the parent repo, configured in `settings.json`:

```json
"hooks": {
  "Notification": [{
    "hooks": [{
      "type": "command",
      "command": "node ~/.claude/scripts/notify.js --event Notification \"Claude Code\" \"message\""
    }]
  }]
}
```

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeNotifications.logPath` | `${userHome}/.claude/logs/notifications.jsonl` | Path to the JSONL log |
| `claudeNotifications.maxEvents` | `500` | Max recent events kept in memory |
| `claudeNotifications.showNativeNotifications` | `false` | Show native OS toast (restart required) |

## Installation

Download the latest `.vsix` from [GitHub Releases](https://github.com/DawnEver/claude-code-config/releases). In VS Code, run **Extensions: Install from VSIX...** and select the downloaded file.

### Troubleshooting

If `npm install` fails with `EACCES` on `.npm` cache, fix the directory ownership and retry:

```bash
sudo chown -R $(whoami) ~/.npm
```

## Development

```bash
npm run compile    # Build + auto-format
npm run watch      # Watch mode
npm run format     # Check formatting
npm run fix        # Auto-format
npm run package    # Package .vsix
```

## Architecture

```
notify.js (hook) -> notifications.jsonl -> extension.ts -> Error popup / Output channel
```

The extension watches `notifications.jsonl` for new lines, deduplicates bursts, and shows error popups with jump actions.
