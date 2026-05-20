# AI Plugin — Multi-Model Orchestration

Delegate tasks and planning to external AI models from Claude Code. Configure providers in `claude_env_settings.json`, then use `/ai:continue` or `/ai:plan`.

## Quick Start

```bash
# In Claude Code:
/ai:continue review this PR for security issues
/ai:plan --provider deepseek --model deepseek-v4-pro implement OAuth2 login
```

## Commands

| Command | Description |
|---|---|
| `/ai:continue` | Delegate investigation/debugging to another model |
| `/ai:plan` | Generate an implementation plan from another model |

## Provider Configuration

Add model providers to `claude_env_settings.json`:

```json
{
  "env:deepseek": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro"
  }
}
```

Each provider needs an Anthropic-compatible Messages API endpoint.

## Adding a New Model

1. Add an `env:<provider>` block to `claude_env_settings.json`
2. Use it: `/ai:continue --provider <provider> ...`

No plugin changes needed.

## Architecture

```
/ai:continue --provider deepseek "review this"
  → Agent("ai-continue")
    → Bash: node ai-companion.mjs task --provider deepseek
      → Reads claude_env_settings.json env:deepseek
      → Calls DeepSeek Anthropic-compatible API
      → Returns verbatim
```

## Files

| Path | Purpose |
|---|---|
| `scripts/ai-companion.mjs` | Core: reads config, calls API |
| `agents/ai-continue.md` | Subagent: forwards to companion |
| `commands/continue.md` | Slash command: `/ai:continue` |
| `commands/plan.md` | Slash command: `/ai:plan` |
| `prompts/task.md` | System prompt for task mode |
| `prompts/plan.md` | System prompt for plan mode |
| `skills/` | Internal runtime contracts |
