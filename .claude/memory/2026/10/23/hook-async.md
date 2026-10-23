---
name: hook-async
description: Which Claude hooks run async and why; the `at` stamp that keeps async bridge state ordered
---

# Async hooks (2026-10-23)

Measured on Windows: bare `node` boot ~0.5s; bridge-hook ~0.58s per run. Before this change every
tool call paid ~1.1s synchronously (PreToolUse bridge in parallel with loop-guard ~0.24s, then
PostToolUse bridge).

**Async** (`"async": true` in `claude_settings.template.json` + the sync-dir payload) — output-free:
bridge-hook on PreToolUse(`*`), PostToolUse, UserPromptSubmit, StopFailure, Notification;
`notify-hook`; SessionStart `prune-cache-hook` (~2s) and `bridge/ensure.mjs` (the channel server
reconnects forever, so a late daemon is fine).

**Stay sync**: `loop-guard-hook` (denies), PreToolUse(AskUserQuestion) `--question` (returns the
answer), Stop bridge (injects queued Telegram messages), `sync-hook --pull` / `setup-check-hook` /
`doctor --hook` (must finish before the session; systemMessage), SessionEnd `sync-hook --remind`
(background work may die at exit).

**Ordering**: async calls can land out of order (e.g. PreToolUse `running` after the
permission-prompt Notification). `bridge-hook.js` stamps each call `at = Date.now()` at start;
`claude-adapter.mjs #mirror` applies a state only if `!(m.at < s.stateAt)`. Unstamped calls always
apply. Test: "an async hook stamped earlier never overwrites a later state". Residual: a turn faster
than ~0.6s can show its prompt after its answer in Telegram (state stays correct). Daemon-side
`s.activity = 'running'` writes (Telegram delivery) do not bump `stateAt`.
