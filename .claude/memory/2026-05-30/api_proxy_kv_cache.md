---
name: api-proxy-kv-cache
description: KV cache metrics removed 2026-05-30 — claude-hud already shows token breakdown natively
metadata:
  type: project
---

## What changed (2026-05-30 — removal)

KV cache tracking was removed as redundant: claude-hud already provides token breakdown natively.

### Removed from `scripts/runtime/api-proxy.js`
- `metrics` object, `persistMetrics()`, `createUsageTracker()` Transform stream
- `/metrics` endpoint
- `Transform` import
- SSE interception in `proxyPassthrough` — now `upRes.pipe(res)` directly

### Removed from `scripts/hooks/hud-hook.js`
- `readKvLabel()` function and ANSI injection logic
- HUD output interception (`console.log` override)
- Now simply imports and calls `pluginModule.main()` directly

### Deleted
- `scripts/runtime/kv-cache-status.js` — was the `--extra-cmd` predecessor, superseded by inline `readKvLabel()`, now both gone

**Why:** claude-hud's built-in token breakdown covers the same information; separate KV ratio tracking added complexity without unique value.
