---
name: agy-runtime-contracts
description: "Measured Antigravity CLI hook, statusLine, env, and main-session runtime contracts"
metadata:
  type: project
---

Measured live against Antigravity CLI 1.5.12 on Windows during full host alignment (2026-11-19):

1. PreToolUse empty object is a denial: returning {} from a PreToolUse hook leaves decision empty in protojson and blocks every tool call (	ool call denied by pre-tool hook:). Neutral pass-through and fail-open handlers must emit {decision:ask} (which respects 	oolPermission: always-proceed without bypassing prompts in normal mode).
2. Tilde expansion in hooks.json: ~ is expanded only at index 0 of command, never after 
ode . Hook commands must use setup-resolved forward-slash paths, and tests must hit a hard tripwire refusing writes to the live ~/.gemini.
3. statusLine.command quoting and quota fields: on Windows statusline_runner escapes
