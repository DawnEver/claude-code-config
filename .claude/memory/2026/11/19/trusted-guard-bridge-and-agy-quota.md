---
title: Trusted Project-Guard Host Bridge & Zero-Token Antigravity Quota Probe
created: 2026-11-19
accessed: 2026-11-19
tier: long-term
tags: [antigravity, codex, hooks, quota, architecture, security]
---

# Trusted Project-Guard Host Bridge & Zero-Token Antigravity Quota Probe

## 1. Canonical Project Guard Protocol (`scripts/hooks/project-guard-bridge.mjs`)

- **Problem**: Rendering separate host manifests (`.claude/` + `.codex/rules/` + `.agents/hooks.json`) into every downstream repo violates single-source-of-truth and still leaves 16 dynamic/path/subagent rules (`codexdeny.py` `GAPS`) unjudged on Codex, while naively running `.claude/settings.json` hooks from a global host hook without origin verification creates a supply-chain RCE vector on untrusted clones.
- **Design**:
  - Repositories declare guards once in `.claude/` (`deny-commands.js` + `deny-rules.json`, `py.js -m dev_lab.dev.hookdispatch <Event>`, `permissions.allow` `Bash(...)` doors). `dev-lab/deny-commands.js` remains strictly single-protocol.
  - Both `scripts/hooks/agy-hook.mjs` and `scripts/hooks/codex-hook.mjs` call `runProjectGuards()` (`scripts/hooks/project-guard-bridge.mjs`), which checks `isTrustedRepo(repoRoot)` against `~/.claude/trusted-origins` (`scripts/runtime/repo-automode.mjs`) before executing any repository hook.
  - `scripts/shared/agy-payload.mjs` is the single source of truth in `cc-config` for Antigravity `<USER_REQUEST>` stripping, cosmetic-arg filtering, and canonical tool/arg normalization.

## 2. Antigravity Quota (`agy -p /quota --output-format json` + `statusLine.telemetry: true`)

- `agy -p /quota --output-format json` executes with `num_turns: 0` and `total_tokens: 0`, returning `command.data.groups[*].buckets[*]` (`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h` with `remaining_fraction` and ISO `reset_time`).
- `AccountReader` refreshes `refreshAgyQuota()` in the background every 10 minutes (with `CC_CONFIG_AGY_SMOKE=1` so child `-p` probes skip outer hook overhead), mapping `3p` to `claude-gpt` and `gemini` to `gemini`, alongside `statusLine` (`telemetry: true`).

## 3. Antigravity Rule-Size Ceiling & `session-bridge` Option A

- Antigravity truncates rule files (`AGENTS.md`, `GLOBAL-AGENTS.md`) at **24,000 bytes**; `doctor.js` `checkRuleFileSize` (`rule-file-size`) FAILs whenever either exceeds 24,000 B.
- Like Codex, `agy` does not use the `session-bridge` MCP channel (`agy-config.mjs` removes any legacy managed `session-bridge` entry from `~/.gemini/config/mcp_config.json`); outbound file attachments use `scripts/bridge/send-attachment.mjs`, which auto-detects `ANTIGRAVITY_CONVERSATION_ID`.
