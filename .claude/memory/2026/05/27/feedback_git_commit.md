---
name: git-commit-use-bash
description: "Always use Bash tool for git commits, never PowerShell"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: da5efa7d-dd97-4eea-b476-72fff87fd4e0
---

Always use Bash (not PowerShell) for `git commit` commands.

**Why:** PowerShell here-strings (`@'...'@`) leak the leading `@` into the commit message, producing messages like `@ docs: ...` instead of `docs: ...`. Bash HEREDOC (`$(cat <<'EOF' ... EOF)`) works correctly.

**How to apply:** When committing, use the Bash tool with the HEREDOC pattern, never PowerShell.
