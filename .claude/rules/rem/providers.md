# Provider Configuration

## VS Code: use environmentVariables, NOT claudeProcessWrapper

Use `claudeCode.environmentVariables` (array of `{name, value}`) to pass provider env vars to
the VS Code chat panel. Do NOT use `claudeCode.claudeProcessWrapper` — Claude Code validates
the binary is a native Claude Code binary; shell scripts and `.cmd` files are rejected with
"native binary not found". `environmentVariables` works identically on Windows, macOS, and Linux.

Run `node scripts/setup/setup-vscode.js deepseek` to configure; `setup-vscode.js` (no args)
to revert to official Claude. Also sets `claudeCode.disableLoginPrompt = true` for non-Claude
providers.

## Model & Effort Strategy

Use `opusplan` model + low effort as default. `opusplan` auto-switches Opus during plan mode
and Sonnet during execution. For critical plan sessions, run `/effort high` before `/plan`.

Sharp-review hook delegates to `/sharp-review` skill — the hook only handles classification
(none/once/triple) and state tracking; all review logic lives in the skill.

## DeepSeek Proxy (`scripts/runtime/api-proxy.js`)

Single-file Node.js proxy (no external deps) on port 3082. Auto-started by `cc.js`.

**Auth:** `ANTHROPIC_AUTH_TOKEN` (NOT `ANTHROPIC_API_KEY`) in `claude_env_settings.json` to
avoid collision with Claude subscription key. The proxy extracts the bearer token and
injects it as `x-api-key` for DeepSeek.

**Critical invariants (do NOT revert):**
- `SAFE_REQ_HEADERS` must include `'anthropic-beta'` — otherwise prompt caching headers are
  dropped before forwarding (100% cache miss).
- Do NOT re-add `stripCacheControl()` — DeepSeek's Anthropic-compatible endpoint supports
  `cache_control` natively.
- Do NOT re-add KV-cache metrics (`metrics`, `persistMetrics`, `/metrics` endpoint, HUD
  `readKvLabel`) — claude-hud shows token breakdown natively.

**Known unfixed bugs:** `fixSystemRoles` mixed Buffer/string return, `proxyPassthrough`
leaks `Content-Type` on error bodies, `content-length` not recalculated after body mutation,
non-text content blocks silently dropped, `ensureProxy` warns but continues on proxy failure.

## ChatGPT Bridge — REMOVED, do NOT re-add

Codex CLI uses `chatgpt.com/codex-backend` with signed agent-identity JWTs (per-session
public/private key pairs). The `~/.codex/auth.json` access token has `api.connectors.*`
scopes only — insufficient for `api.openai.com` and incompatible with `chatgpt.com` backend.
Proxy approach is architecturally incompatible. Do not re-add unless using a real OpenAI API
key (not Codex subscription tokens).

**What was deleted (do NOT restore):** `api-proxy.js` ChatGPT route, `cc.js` gpt provider,
`ccgpt` aliases/`.cmd`, `claude_env_settings.json` gpt env block, `AGENTS.md` provider docs.
