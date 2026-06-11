---
name: api-proxy-cache-fix
description: Fixed two bugs in api-proxy.js that silently disabled DeepSeek prompt caching
metadata:
  type: project
---

## What changed (2026-05-30)

Fixed two bugs in `scripts/runtime/api-proxy.js` that prevented DeepSeek prompt caching from working.

### Bug 1: `anthropic-beta` header stripped
`SAFE_REQ_HEADERS` whitelist did not include `anthropic-beta`. Claude Code sends `anthropic-beta: prompt-caching-2024-07-31` to enable prompt caching; the proxy dropped it before forwarding to DeepSeek.

**Fix:** Added `'anthropic-beta'` to `SAFE_REQ_HEADERS`.

### Bug 2: `cache_control` fields stripped
`stripCacheControl()` recursively removed all `cache_control` fields from the request body. The comment claimed DeepSeek ignores them, but DeepSeek's Anthropic-compatible endpoint (`api.deepseek.com/anthropic`) actually supports `cache_control` markers for prompt caching.

**Fix:** Removed `stripCacheControl()` function and its call in `normalizeRequest()`.

**Why:** Both changes together caused 100% cache miss rate on ccds sessions. DeepSeek received no cache markers and no beta header, so it never cached anything.

**Validation status:** Proxy restarted; full end-to-end validation (cache_read_input_tokens > 0 in HUD) pending.
