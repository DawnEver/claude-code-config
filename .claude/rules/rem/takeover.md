# Takeover Plugin — Distilled

## Model resolution (fixed 2026-06-08)
`resolveModel()` maps logical tier names `"sonnet"/"opus"/"haiku"` to provider-specific model names via the provider's `ANTHROPIC_DEFAULT_*_MODEL` config. Passing `model="sonnet"` to a DeepSeek provider now correctly resolves to `"deepseek-v4-flash"` (or whatever is configured). Non-tier names (e.g. `"deepseek-v4-pro"`) pass through unchanged. cc-market commit e163bca.

## Config
- Config path overridable via `TAKEOVER_CONFIG_PATH` env var

## Architectural invariants (2026-05-28)
- Prompt always via stdin, never in spawn args
- `callCodexCompanion`, `callAnthropicAPI`, `callNativeClaude` exported testable in `lib.mjs`
- Both `/takeover:continue` and `/takeover:plan` route through Agent(`takeover:takeover`)
- `--write` rejected early for non-codex providers
- Retry: 429/502/503/504 → 2 exponential-backoff retries (1s, 2s); 4xx → fail immediately

## Tests
Run: `node --test cc-market/takeover/tests/lib.test.mjs cc-market/takeover/tests/mcp-server.test.mjs`

## Windows (2026-06-03)
- `spawn("claude", ...)` needs `shell: process.platform === "win32"` — otherwise resolves POSIX script instead of `claude.cmd`

→ See `.claude/memory/` for full history: takeover-model-bug, takeover-plugin-v2, project_takeover_review
