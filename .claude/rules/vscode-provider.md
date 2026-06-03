# VS Code Provider Configuration

Use `claudeCode.environmentVariables` (array of `{name, value}`) for provider switching in the VS Code chat panel.

**Why:** `claudeCode.claudeProcessWrapper` is BROKEN — Claude Code validates the binary is native, rejects shell scripts and `.cmd` files. `environmentVariables` injects env vars directly, works on all platforms.

**How to apply:** Run `node scripts/setup/setup-vscode.js deepseek` to configure DeepSeek, or no-args to revert to official Claude.
