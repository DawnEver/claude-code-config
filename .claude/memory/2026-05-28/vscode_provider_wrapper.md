---
name: vscode-provider-wrapper
description: claudeCode.claudeProcessWrapper is BROKEN — Claude Code validates native binary; shell script wrappers rejected
metadata:
  type: feedback
---

Do NOT use `claudeCode.claudeProcessWrapper` to route to a DeepSeek wrapper (`ccds` or any shell script). Claude Code validates the binary is a native Claude Code binary; shell scripts are rejected with "native binary not found".

**Why:** When Claude Code spawns subagents (Agent tool), it passes `claudeCode.claudeProcessWrapper` as `pathToClaudeCodeExecutable` and does a native binary check. A shell script like `ccds` fails this check. Full macOS path `/Users/linxu/.local/bin/ccds` was synced via Settings Sync (broken), bare `ccds` also fails the same binary validation.

**How to apply:** Leave `claudeCode.claudeProcessWrapper` unset. For DeepSeek via VS Code terminal, use `terminal.integrated.env.osx` (macOS) or run `ccds` from terminal. Alternatively, modify the proxy to own its own API key so `claudeCode.environmentVariables` can set just `ANTHROPIC_BASE_URL` without a platform-specific token.
