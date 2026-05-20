---
name: ai-cli-runtime
description: Internal helper contract for calling the ai-companion runtime from Claude Code
---

# AI Companion Runtime

## Provider Configuration

Providers are configured in the project's `claude_env_settings.json` under `env:<provider>` keys.

Each provider block must contain:
- `ANTHROPIC_BASE_URL` — Anthropic-compatible API endpoint
- `ANTHROPIC_AUTH_TOKEN` — API key
- `ANTHROPIC_DEFAULT_OPUS_MODEL` — model for large tasks
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — balanced model (default)
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — fast/light model

## Companion Script

The companion script lives at `${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs`.

### Subcommands

- `task --provider <name> [--model <m>] <prompt>` — Run a continue/investigation task (read-only)
- `plan --provider <name> [--model <m>] <prompt>` — Generate an implementation plan

### Behavior

- Reads provider config from `claude_env_settings.json`
- Calls the configured Anthropic-compatible Messages API
- Returns only the response text (stdout), diagnostics go to stderr
- Default model is the provider's `ANTHROPIC_DEFAULT_SONNET_MODEL`
- All tasks run in read-only mode (file modifications not yet supported)
