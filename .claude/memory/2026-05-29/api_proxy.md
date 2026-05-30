---
name: api-proxy
description: Local proxy for DeepSeek only. Auth fix 2026-05-30: bearer→x-api-key conversion added so ANTHROPIC_AUTH_TOKEN works. KV cache metrics, cache_control strip. Some sharp-review bugs remain unfixed.
metadata:
  type: project
---

`scripts/runtime/api-proxy.js` — single-file Node.js proxy (no external deps) on port 3082.

**Route /deepseek/***: Strips `{ role: "system" }` entries from `messages[]` (injected by Claude Code 2.1.154+), merges their text into top-level `system` field, forwards to DeepSeek.

**ChatGPT bridge removed 2026-05-29** — Codex uses signed agent-identity JWTs at `chatgpt.com/codex-backend`; the OAuth token from `~/.codex/auth.json` only has `api.connectors.*` scopes, insufficient for any standard API endpoint. See [[ccgpt-removal]].

**Auto-start**: `cc.js` checks port 3082 via TCP + HTTP `/health` before launching Claude; spawns proxy detached if not running, polls 3s.

**Why:** DeepSeek rejects system-role in messages array.

**How to apply:** Run `ccds` — proxy starts automatically. `ccproxy` for manual foreground start.

## Auth fix (2026-05-30)

`ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_KEY`) is used in `claude_env_settings.json` to avoid collision with the user's Claude Pro subscription key. This env var causes Claude Code to send `Authorization: Bearer <key>` — NOT `x-api-key`. The proxy now extracts the bearer token and injects it as `x-api-key` in `handleDeepSeek`. Do NOT change the config to `ANTHROPIC_API_KEY`.

**Why:** User has both Claude Pro subscription and DeepSeek API key; `ANTHROPIC_API_KEY` would be ambiguous / could override the subscription key.

## Remaining known bugs (from 2026-05-29 sharp review — NOT YET FIXED)

- `fixSystemRoles` returns mixed Buffer/string type — should normalize to one type
- `proxyPassthrough` transparently forwards upstream response headers including `Content-Type` on error bodies
- DeepSeek `content-length` not recalculated after `fixSystemRoles` mutates body
- Non-text content blocks (images, tool_use) silently dropped in `contentToString` — warns but no fallback
- `ensureProxy` warns and continues if proxy doesn't start — should `process.exit(1)`
- TCP connect ≠ proxy health; a hung proxy passes the port check (mitigated by `/health` HTTP check)
