---
name: local-llama-ccla-codla
description: ccla/codla launch Claude Code and Codex on the local llama.cpp provider, local-only; the relock PR is blocked on a memory amend
title: ccla and codla on local llama.cpp, local-only sessions
created: 2026-11-27
tags: [providers, llama.cpp, codex, bridge, usage, privacy]
---

# ccla / codla on local llama.cpp (2026-11-27)

## Landed on integrate/main
- #63 `ccla` (Claude Code) and `codla` (Codex) on ai-lab's keyless `llamacpp` row (ai-lab #67).
  A local row (`auth = "local"`) needs no projection rule and no key (`resolveProvider`,
  `projectedProviders`). Claude Code base URL = catalogue anthropic endpoint minus trailing `/v1`
  (`claudeBaseUrl`); Codex block has no `env_key`, `wire_api = "responses"` (llama-server serves it).
- `scripts/shared/local-serve.mjs`: both launchers run `ai_lab.serve ensure <provider>` first; Codex gets
  the running server's `/props` n_ctx as `model_context_window` (one source: the server).
- Local-only (`scripts/shared/local-only.mjs`): `HARNESS_LOCAL_ONLY=1` gates `bridge-hook.js`; the Codex
  bridge drops threads/rollouts whose provider is `auth = "local"` (`isMainSession`, `CodexLocalObserver`);
  ccla adds `--strict-mcp-config --disallowedTools WebSearch,WebFetch` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; codla `mcp_servers={}`, `web_search="disabled"`,
  `analytics.enabled=false`.
- #66 usage scanner never sends a session whose model is any role model of a local row
  (`localModelTest`, re-read per collect).

## Lesson
- A `[model_providers.<id>]` named like a Codex built-in (`openai`, `ollama`, `lmstudio`, `oss`) makes
  Codex refuse the WHOLE config.toml. Hit live: link self-heal recomposed `~/.codex/config.toml` from a
  feature branch in the live checkout. `CODEX_BUILTIN_PROVIDERS` now skips them. Working a branch in the
  live checkout is live for every session -- restore main after.
- `forge` merged #63 before a later push to its branch: push follow-ups as a new PR.

## Open (blocked)
- Branch `pr/toolchain/local-llama-ai-lab-lock` (not pushed): relock ai-lab + dev-lab + lab-commons TOGETHER
  (ai-lab alone conflicts on lab-commons URLs), principles re-render into GLOBAL-AGENTS.md,
  `max_idle = "12 h"`. Family hooks now installed (`.githooks/`). Push refused: pre-commit public-hygiene
  flags private markers in `handoff-three-host-env-sync.md`, while pre-push memory-adds refuses editing it
  without a user-approved `> Amended` note. Waiting for the user's approval words.
- Until it lands, cc-config's venv has the newer relocked packages ahead of main's lock.
- `<project>` is frozen; its v1 lives in the `<org>` Gitea v1 repo -- connect <project>-v1 there.
