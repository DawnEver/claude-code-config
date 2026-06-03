# API Proxy

`scripts/runtime/api-proxy.js` — local proxy on port 3082 for DeepSeek. Auto-started by `cc.js`.

## Key config
- Use `ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_KEY`) — avoids collision with Claude Pro subscription
- `ccds` launches with Foundry mode (`CLAUDE_CODE_USE_FOUNDRY=1`, direct to `api.deepseek.com/anthropic`)
- Proxy strips system-role from messages[] (DeepSeek rejects), merges into top-level `system`

## Prompt caching
- `anthropic-beta` header preserved in `SAFE_REQ_HEADERS`
- `cache_control` fields NOT stripped (DeepSeek's Anthropic endpoint supports them)

## ChatGPT bridge REMOVED
Codex uses signed agent-identity JWTs — incompatible with any standard API endpoint. Do NOT re-add without real OpenAI API key.

## Known bugs → see `.claude/memory/` for current unfixed issues
