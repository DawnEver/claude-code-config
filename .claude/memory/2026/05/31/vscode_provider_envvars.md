---
name: vscode-provider-envvars
description: claudeCode.environmentVariables works on all platforms for VS Code chat panel provider switching
metadata:
  type: feedback
created: 2026-05-31
accessed: 2026-06-10
tier: short
access_count: 1
---

Use `claudeCode.environmentVariables` (array of `{name, value}`) to pass provider env vars to the VS Code chat panel's spawned Claude Code process. This replaces the broken `claudeCode.claudeProcessWrapper` approach which only worked with native binaries on macOS/Linux.

**Why:** `claudeProcessWrapper` validates the binary is a native Claude Code executable — shell scripts are rejected. On Windows, `.cmd` files aren't spawnable by the extension either. The `environmentVariables` setting avoids both issues by injecting env vars directly into the spawned process, working identically on Windows, macOS, and Linux.

**How to apply:** Use `setup-vscode.js` which now sets `claudeCode.environmentVariables` from the provider profile in `claude_env_settings.json`. Run `node scripts/setup/setup-vscode.js deepseek` to configure DeepSeek, or `node scripts/setup/setup-vscode.js` (no args) to revert to official Claude. Also sets `claudeCode.disableLoginPrompt = true` for non-Claude providers.

**Related:** [[vscode-provider-wrapper]] — the old broken approach; this supersedes it.
