---
name: api-proxy
description: Local proxy for DeepSeek only (ChatGPT bridge removed 2026-05-29). Some sharp-review bugs remain unfixed.
metadata:
  type: project
---

`scripts/runtime/api-proxy.js` — single-file Node.js proxy (no external deps) on port 3082.

**Route /deepseek/***: Strips `{ role: "system" }` entries from `messages[]` (injected by Claude Code 2.1.154+), merges their text into top-level `system` field, forwards to DeepSeek.

**ChatGPT bridge removed 2026-05-29** — Codex uses signed agent-identity JWTs at `chatgpt.com/codex-backend`; the OAuth token from `~/.codex/auth.json` only has `api.connectors.*` scopes, insufficient for any standard API endpoint. See [[ccgpt-removal]].

**Auto-start**: `cc.js` checks port 3082 via TCP + HTTP `/health` before launching Claude; spawns proxy detached if not running, polls 3s.

**Why:** DeepSeek rejects system-role in messages array.

**How to apply:** Run `ccds` — proxy starts automatically. `ccproxy` for manual foreground start.

## Remaining known bugs (from 2026-05-29 sharp review — NOT YET FIXED)

- `fixSystemRoles` returns mixed Buffer/string type — should normalize to one type
- `proxyPassthrough` transparently forwards upstream response headers including `Content-Type` on error bodies
- DeepSeek `content-length` not recalculated after `fixSystemRoles` mutates body
- Non-text content blocks (images, tool_use) silently dropped in `contentToString` — warns but no fallback
- `ensureProxy` warns and continues if proxy doesn't start — should `process.exit(1)`
- TCP connect ≠ proxy health; a hung proxy passes the port check (mitigated by `/health` HTTP check)
