---
name: feedback-no-auto-push
description: Don't push without user confirmation
metadata:
  type: feedback
  created: 2026-06-06
---

# No Auto Push

Always ask for user confirmation before `git push`. Do not push automatically after commit.

**Why:** User wants explicit control over when code leaves the local machine.

**How to apply:** After committing, state what was committed and ask "push?" or similar. Never chain commit + push in one action without asking.
