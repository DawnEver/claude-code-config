# Takeover Plugin

## Architectural invariants
- Prompt always via stdin, never in spawn args
- `callCodexCompanion`, `callAnthropicAPI`, `callNativeClaude` are exported testable functions in `lib.mjs`
- Both `/takeover:continue` and `/takeover:plan` route through Agent(`takeover:takeover`)
- `--write` rejected early for non-codex providers
- Retry: 429/502/503/504 → 2 exponential-backoff retries (1s, 2s); 4xx → fail immediately
- Config path overridable via `TAKEOVER_CONFIG_PATH`

## MCP server
- `.mcp.json` declares server with `${CLAUDE_PLUGIN_ROOT}` — cross-platform, auto-started/stopped by Claude Code
- Name/version read from `.claude-plugin/plugin.json` at runtime (not hardcoded)
- Windows: `spawn("claude", ...)` needs `shell: process.platform === "win32"`

## Tests
Run: `node --test cc-market/takeover/tests/lib.test.mjs`

## Version bumping
`scripts/bump-version.sh` bumps patch in `.claude-plugin/plugin.json`. Pre-push hook in `cc-market/.git/hooks/pre-push` auto-calls it per changed plugin.
