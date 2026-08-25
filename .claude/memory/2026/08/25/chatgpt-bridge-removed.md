---
name: chatgpt-bridge-removed
description: Codex ChatGPT bridge is architecturally incompatible with Codex's signed agent-identity JWTs; deleted 2026-08-25.
metadata:
  type: project
---

# ChatGPT bridge — removed, do not re-add

**Decision date:** 2026-08-25
**Why:** Codex CLI uses `chatgpt.com/codex-backend` with signed agent-identity JWTs
(per-session public/private key pairs). The `~/.codex/auth.json` access token carries
`api.connectors.*` scopes only — insufficient for `api.openai.com` and incompatible
with the `chatgpt.com` backend. A proxy approach is architecturally incompatible.

**Re-add only if** using a real OpenAI API key (not a Codex subscription token), in
which case add a new `providers.openai` block in `claude_env_settings.json` and
register the alias through the normal flow.

**What was deleted (do NOT restore):**

- `api-proxy.js` ChatGPT route
- `cc.js` `gpt` provider
- `ccgpt` aliases / `.cmd` wrappers
- `claude_env_settings.json` `gpt` env block
- `AGENTS.md` provider docs
