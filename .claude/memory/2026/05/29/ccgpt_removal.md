---
name: ccgpt-removal
description: ChatGPT subscription bridge removed — Codex uses agent-identity JWT auth incompatible with proxy approach
metadata:
  type: project
created: 2026-05-29
accessed: 2026-05-29
tier: short
---

ChatGPT subscription bridge (`ccgpt`, `/chatgpt` proxy route) fully removed.

**Why:** The Codex CLI uses `chatgpt.com/codex-backend` with signed agent-identity JWTs (per-session public/private key pairs, not just a Bearer token). The `~/.codex/auth.json` access token only has `api.connectors.*` scopes — insufficient for `api.openai.com/v1/chat/completions` (returns 429) and incompatible with the chatgpt.com backend (requires cryptographic agent assertion). The proxy approach is architecturally incompatible.

**Also fixed in same session:** Path construction bug in `handleChatGPT` — target was `https://api.openai.com/v1` so pathname `/v1` + stripped path `/v1/messages` = `/v1/v1/messages` (404). Fixed but moot after removal.

**What was deleted:**
- `api-proxy.js`: token management, `anthropicToOAI`/`oaiToAnthropic`, SSE stream bridge, `handleChatGPT`, `/chatgpt` route, `os` import
- `cc.js`: removed `gpt` from `PROXY_PROVIDERS`
- `aliases.ps1` / `aliases.sh`: removed `ccgpt`
- `setup.js`: removed `ccgpt` alias install entry
- `claude_env_settings.json` / `.template.json`: removed `env:gpt` and `proxy.chatgpt`
- `AGENTS.md`: updated provider switching docs
- Installed binaries `ccgpt.cmd` / `ccgpt` deleted from `C:\Users\linxu\nodejs`

**How to apply:** Do not re-add a ChatGPT/OpenAI bridge unless using a real OpenAI API key (not Codex subscription tokens).
