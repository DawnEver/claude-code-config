# Claude Code Cross-Platform Configuration Sync

Sync Claude Code configuration files across multiple devices via OneDrive to maintain a consistent development environment.

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

This script auto-detects the OneDrive source directory and creates symbolic links in `~/.claude/`. Works on macOS, Windows, and Linux. Run it again to verify existing links — it won't overwrite files.

If `settings.json` doesn't exist (it's gitignored to protect secrets), setup automatically copies `settings.template.json` → `settings.json`. Edit your local `settings.json` with your API key and personal config.

**Windows note:** If you get a privilege error, enable Developer Mode in Windows Settings or run as Administrator.

## Available Models
```bash
!cat ~/.claude/models.md
```
