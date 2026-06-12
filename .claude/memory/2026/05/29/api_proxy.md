---
name: api-proxy
description: Local DeepSeek proxy (scripts/runtime/api-proxy.js) — auth, prompt caching, KV-metrics removal, known unfixed bugs
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

`ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_KEY`) is used in `claude_env_settings.json` to avoid collision with the user's Claude subscription key. This env var causes Claude Code to send `Authorization: Bearer <key>` — NOT `x-api-key`. The proxy now extracts the bearer token and injects it as `x-api-key` in `handleDeepSeek`. Do NOT change the config to `ANTHROPIC_API_KEY`.

**Why:** User has both Claude subscription and DeepSeek API key; `ANTHROPIC_API_KEY` would be ambiguous / could override the subscription key.

## Remaining known bugs (from 2026-05-29 sharp review — NOT YET FIXED)

- `fixSystemRoles` returns mixed Buffer/string type — should normalize to one type
- `proxyPassthrough` transparently forwards upstream response headers including `Content-Type` on error bodies
- DeepSeek `content-length` not recalculated after `fixSystemRoles` mutates body
- Non-text content blocks (images, tool_use) silently dropped in `contentToString` — warns but no fallback
- `ensureProxy` warns and continues if proxy doesn't start — should `process.exit(1)`
- TCP connect ≠ proxy health; a hung proxy passes the port check (mitigated by `/health` HTTP check)

## Prompt caching fix (2026-05-30)

Two bugs in `api-proxy.js` silently disabled DeepSeek prompt caching (100% cache miss on ccds sessions):
1. `SAFE_REQ_HEADERS` didn't whitelist `anthropic-beta` — Claude Code's `anthropic-beta: prompt-caching-2024-07-31` header was dropped before forwarding.
2. `stripCacheControl()` recursively removed all `cache_control` fields from the request body, on the (incorrect) assumption DeepSeek ignores them — DeepSeek's Anthropic-compatible endpoint (`api.deepseek.com/anthropic`) actually supports `cache_control`.

**Fix:** added `'anthropic-beta'` to `SAFE_REQ_HEADERS`; removed `stripCacheControl()` and its call in `normalizeRequest()`. Don't re-add either.

## KV-cache metrics removed (2026-05-30)

Removed as redundant — claude-hud already shows token breakdown natively. Don't re-add:
- `metrics` object, `persistMetrics()`, `createUsageTracker()` Transform stream, `/metrics` endpoint, `Transform` import from `api-proxy.js`
- `readKvLabel()` and HUD output interception (`console.log` override) from `scripts/hooks/hud-hook.js` — now just calls `pluginModule.main()` directly
- `scripts/runtime/kv-cache-status.js` (predecessor of `readKvLabel()`) — deleted
