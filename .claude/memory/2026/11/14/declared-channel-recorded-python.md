---
name: declared-channel-recorded-python
description: "Telegram messages count as the user only when the bridge's recorded python can read the dev-lab channel declaration"
metadata:
  type: project
---

# Telegram = user needs a recorded python with dev_lab.dev.devhost

The global rule trusts a session-bridge message only with declared="true". The channel server
(claude_plugins/session-bridge/server.mjs readChannelDeclaration) runs
`<recorded python> -m dev_lab.dev.devhost channels --json`; any failure fails closed (all
messages declared="false"), silently.

2026-11-14 on host G: the recorded python (~/.claude/provider-cache.json `python`) was the
ai-lab `runtime-2` worktree venv, which lacked dev_lab.dev.devhost. Fix: re-run
`node scripts/setup/setup.js --ai-lab-python <PEMC/ai-lab/.venv python>`.
The declaration itself lives in hosts-config `hosts/<name>.toml` `[dev] channels`
(only G declared so far); dev-lab renders it into the machine file's `[agent] channels`.
The channel reads it only at start, so restart ccc after fixing.

Same session: PR #10 (dashboard bulk-reset account picking; template env
CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1, also set in the synced claude_settings.json).
