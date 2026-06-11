---
name: vscode-provider-wrapper
description: claudeCode.claudeProcessWrapper is BROKEN — Claude Code validates native binary; shell script wrappers rejected
metadata:
  type: feedback
created: 2026-05-28
accessed: 2026-06-10
tier: short
access_count: 1
---

Do NOT use `claudeCode.claudeProcessWrapper` to route to a DeepSeek wrapper (`ccds` or any shell script). Claude Code validates the binary is a native Claude Code binary; shell scripts are rejected with "native binary not found".

**Why:** When Claude Code spawns subagents (Agent tool), it passes `claudeCode.claudeProcessWrapper` as `pathToClaudeCodeExecutable` and does a native binary check. A shell script like `ccds` fails this check. Full macOS path `/Users/linxu/.local/bin/ccds` was synced via Settings Sync (broken), bare `ccds` also fails the same binary validation.

**How to apply:** Leave `claudeCode.claudeProcessWrapper` unset. For DeepSeek, use `claudeCode.environmentVariables` instead ([[vscode-provider-envvars]]) — works on all platforms. Run `node scripts/setup/setup-vscode.js deepseek` to configure it.
