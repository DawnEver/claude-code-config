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

### OpenSpec

```sh
npm install -g @fission-ai/openspec@latest
```

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
