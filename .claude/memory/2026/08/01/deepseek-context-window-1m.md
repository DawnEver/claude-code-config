---
name: deepseek-context-window-1m
---

# DeepSeek context window: `[1m]` suffix is the only lever for third-party models

Question (2026-08-01): why does `deepseek-v4-flash` show only 200K context when the model
supports 1M? Answer: Claude Code infers the context window **client-side**; the resolution
priority is (1) `[1m]` suffix in the model id → 1M, (2) provider metadata
`max_input_tokens`, (3) `context-1m` beta header (Anthropic/Bedrock only), (4) **fallback
default 200,000**. For a third-party Anthropic-compatible endpoint (DeepSeek/Kimi via
`ANTHROPIC_BASE_URL`) paths 2–3 never apply — so the `[1m]` suffix is the *only* way to get
a 1M window. Any unfamiliar model id without the suffix is silently capped at 200K.

## Fix applied (commit 51e05bd)

`claude_env_settings.json` + `claude_env_settings.template.json` `env:deepseek` block: all
five flash model strings changed `deepseek-v4-flash` → `deepseek-v4-flash[1m]`
(`ANTHROPIC_MODEL`, OPUS/SONNET/HAIKU defaults, `CLAUDE_CODE_SUBAGENT_MODEL`). Fable stays
`deepseek-v4-pro[1m]`. The settings file (real keys) is gitignored; only the template is
tracked.

## Verified empirically (2026-08-01): DeepSeek accepts the `[1m]` suffix

Probed `https://api.deepseek.com/anthropic/v1/messages` with model strings
`deepseek-v4-flash`, `deepseek-v4-flash[1m]`, `deepseek-v4-pro`, `deepseek-v4-pro[1m]` —
all HTTP 200; responses echo the bare model name (`deepseek-v4-flash`), i.e. DeepSeek
normalizes the suffix server-side. The earlier "observe proxy would leak `[1m]` and be
rejected" caveat does NOT apply to DeepSeek — even a verbatim-forwarded
`deepseek-v4-flash[1m]` through `fabric/engine/observe-proxy.mjs` is accepted. (Unverified
for Kimi / other providers — re-test if adding `[1m]` there.)

`max_input_tokens` is NOT a viable alternative: DeepSeek serves no Anthropic-style model
metadata (`GET /anthropic/v1/models` → 404; only OpenAI-style `GET /v1/models` → 200
listing both models), so that branch of Claude Code's context-window chain is unreachable.
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` (priority-1 override) is reported buggy for non-Anthropic
backends (anthropics/claude-code#62070) — not reliable. `[1m]` remains the only lever.

Diagnostic note: the two Agent-fork "temporarily unavailable" errors that triggered this
investigation (and one Bash error) were a transient auto-mode safety-classifier outage, NOT
suffix rejection — the same fork succeeded on retry, and DeepSeek returns 200 for the
suffixed string.

## Known upstream bugs (context for later)

- Subagents may still default to 200K even when the parent model is `[1m]`
  (anthropics/claude-code#39047).
- `--model` flag / some versions silently strip `[1m]` (anthropics/claude-code#50803,
  #61037) — keep the suffix in env vars and launcher scripts, not just settings.json.
