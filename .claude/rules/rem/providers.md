# Provider Configuration

## Secrets are machine-local (`claude_env_settings.local.json`)

The shared `claude_env_settings.json` rides OneDrive, so it must NOT carry API keys. Each
machine keeps its own in `~/.claude/claude_env_settings.local.json` — a REAL per-machine dir
(setup.js only junctions specific children into the repo), so it never syncs. setup.js copies
it from `claude_env_settings.local.template.json` on first run. Shape mirrors the shared
registry; every config reader deep-merges local over shared (override wins), so the shared
file keeps base URLs / model pins and the local file keeps keys:

```json
{ "env:deepseek": { "ANTHROPIC_API_KEY": "sk-..." },
  "env:kimi":    { "ANTHROPIC_API_KEY": "sk-..." } }
```

Consumers: root `scripts/shared/config.mjs` `readMergedEnvSettings()` (`cc.js`,
`setup-vscode.js`) and fabric `engine/providers.mjs` `readRegistry()` +
`engine/node-config.mjs` `loadFabricConfig()` (`~/.claude/claude_env_settings.local.json`).
A machine without a local file fails with the existing "missing ANTHROPIC_API_KEY" error —
the intended failure mode (each host must supply its own key). The same mechanism can
override `fabric.token`/`fabric.tokens` per machine if you ever want per-host node tokens.

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

## Direct Anthropic-compatible providers (DeepSeek, Kimi)

Both DeepSeek (`ccds`) and Kimi (`cckm`) connect through Claude Code's native
Anthropic-compatible endpoint — `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` plus the
`ANTHROPIC_*_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` overrides. The base URL / model pins ride
the shared `claude_env_settings.json`; each machine's `ANTHROPIC_API_KEY` comes from its local
`~/.claude/claude_env_settings.local.json` (see "Secrets are machine-local" above).
No Foundry mode, no local proxy — `cc.js` just injects the profile's env vars into Claude Code.
DeepSeek was migrated off Foundry mode (`CLAUDE_CODE_USE_FOUNDRY` / `ANTHROPIC_FOUNDRY_*`) to
this simpler direct style so both providers share one config shape.

## ChatGPT Bridge — REMOVED, do NOT re-add

Codex CLI uses `chatgpt.com/codex-backend` with signed agent-identity JWTs (per-session
public/private key pairs). The `~/.codex/auth.json` access token has `api.connectors.*`
scopes only — insufficient for `api.openai.com` and incompatible with `chatgpt.com` backend.
Proxy approach is architecturally incompatible. Do not re-add unless using a real OpenAI API
key (not Codex subscription tokens).

**What was deleted (do NOT restore):** `api-proxy.js` ChatGPT route, `cc.js` gpt provider,
`ccgpt` aliases/`.cmd`, `claude_env_settings.json` gpt env block, `AGENTS.md` provider docs.
