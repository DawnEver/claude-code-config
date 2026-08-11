---
name: system-prompt-paths-symlink
description: Platform prompt paths are now machine-independent — setup.js links ~/.claude/system-prompt and ~/.codex/system-prompt to the synced repo; shared configs reference prompts by symlink path, never a OneDrive absolute path
created: 2026-08-11
tags: [system-prompt, fabric, codex, setup, paths]
---

# Platform prompt paths — symlink convention (2026-08-11)

The shared configs (`claude_env_settings.json` `fabric.systemPromptFile`,
`codex_config.toml` `model_instructions_file`) used to hardcode G's absolute OneDrive path
(`C:/Users/linxu/OneDrive - The University of Nottingham/Sync/claude/system-prompt/...`).
The fleet has mixed usernames (G/WS2 = linxu, WS1 = **ezxmb14**): on WS1 that path does not
exist, and the CLI exited 1 at startup for EVERY session there (reproduced live).

**New convention — never a OneDrive path in shared config.**
- `scripts/setup/setup.js` links dir junctions `~/.claude/system-prompt` and
  `~/.codex/system-prompt` → `<repo>/system-prompt` (both in `CLAUDE_LINKS`/`CODEX_LINKS`).
- `fabric.systemPromptFile = "~/.claude/system-prompt/claude-base.md"` — fabric's
  `resolveSystemPromptFile` (cc-market/fabric/engine/node-config.mjs) expands `~` → home;
  the junction resolves into the repo. Resolved value contains no OneDrive.
- `codex_config.toml model_instructions_file = "~/.codex/system-prompt/codex-base.md"` —
  codex expands `~`/`./` against `~/.codex/` (officially supported).
- `resolveSystemPromptFile` keeps an absolute-path passthrough and a relative→repo-root
  fallback (works before setup runs). Both CLI injection sites also skip a missing file
  with a stderr warning, so an unsynced machine still spawns (stock prompt) instead of dying.

**Operational:** each machine needs `npm run setup` (creates the two junctions) once. The
fabric session side is v0.1.21; the root-repo side is commit e98f78c.
