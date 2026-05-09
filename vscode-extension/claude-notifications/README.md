# Claude Notifications

Show Claude Code hook notifications inside VS Code as info popups with a jump action.

## Features

- **Info popups** — new notifications from `notify.js` appear as `showInformationMessage` popups showing the project path + "Need attention"
- **Jump to project** — each popup has a **Go to Context** button that runs `vscode.openFolder` to switch to the notification's working directory

## Requirements

Requires the `scripts/notify.js` hook script from the parent repo, configured in `settings.json`:

```json
"hooks": {
  "Notification": [{
    "hooks": [{
      "type": "command",
      "command": "node ~/.claude/scripts/notify.js --show-native false"
    }]
  }]
}
```

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeNotifications.logPath` | `${userHome}/.claude/logs/notifications.jsonl` | Path to the JSONL log |

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
npm run test       # Claude try to read ~/.claude/settings.json to request permision, to test 
```

## Architecture

```
notify.js (hook) -> notifications.jsonl -> extension.ts -> Info popup
```

The extension watches `notifications.jsonl` for new lines, deduplicates bursts, and shows info popups with a jump action.
