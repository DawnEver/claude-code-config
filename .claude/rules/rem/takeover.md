# Takeover Plugin — Distilled

## Known bugs

### Model selection bug (2026-06-04)
`mcp__plugin_takeover_takeover__call_model` always sends `model: "sonnet"` regardless of `--provider`. DeepSeek/Claude takeover reviewers fail with "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed sonnet". Root cause: model selection in `cc-market/takeover/lib.mjs` or `mcp-server.mjs` doesn't respect provider context. Blocks sharp review (2 of 3 reviewers broken).

## Architectural invariants (2026-05-28)
- Prompt always via stdin, never in spawn args
- `callCodexCompanion`, `callAnthropicAPI`, `callNativeClaude` exported testable in `lib.mjs`
- Both `/takeover:continue` and `/takeover:plan` route through Agent(`takeover:takeover`)
- `--write` rejected early for non-codex providers
- Retry: 429/502/503/504 → 2 exponential-backoff retries (1s, 2s); 4xx → fail immediately

## Windows (2026-06-03)
- `spawn("claude", ...)` needs `shell: process.platform === "win32"` — otherwise resolves POSIX script instead of `claude.cmd`

→ See `.claude/memory/` for full history: takeover-model-bug, takeover-plugin-v2, project_takeover_review
