---
name: update-plugins-hook-removed
description: Removed update-plugins-hook.js — Claude Code built-in autoUpdate replaces it
metadata:
  type: project
created: 2026-06-03
accessed: 2026-06-03
tier: short
---

# update-plugins-hook.js Removed

Removed `scripts/hooks/update-plugins-hook.js` and its SessionStart hook registration.

**Why:** Claude Code now natively auto-updates plugins when `extraKnownMarketplaces[].autoUpdate: true` is set. The hand-rolled git-pull-every-6-hours hook is redundant.

**How to apply:** Do NOT re-add plugin auto-update scripts. The `extraKnownMarketplaces` entries in `claude_settings.json` already handle this.
