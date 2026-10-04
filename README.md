# Claude Code & Codex Cross-Platform Config Sync

One configuration for Claude Code and Codex on every machine. The working tree travels via git;
only a three-file config payload rides cloud storage (OneDrive, Dropbox, … — or nothing, the
zero-config default).

> **Never put the working tree inside a cloud-synced folder.** A sync daemon replicating `.git/`
> corrupts the index and overwrites the reflog.

MIT-licensed, but built for personal use and rapid iteration: backward compatibility is not a
concern. Third-party tools and separately cloned repos keep their own licences.

## Quick start

Prerequisites: [Node.js](https://nodejs.org/en/download),
[Claude Code](https://code.claude.com/docs/en/setup) and/or
[Codex](https://github.com/openai/codex).

```sh
npm run setup                         # link ~/.claude and ~/.codex to this repo
npm run setup -- --machine host-a     # name this host (once per machine)
npm run doctor                        # must report no FAIL
```

Then put your API keys in `~/.claude/claude_env_settings.local.json` (machine-local, never synced).

## Daily use

| Command | What it starts |
|---|---|
| `ccc` / `ccds` | Claude Code — official subscription / DeepSeek |
| `codc` / `cods` | Codex — official provider / DeepSeek |
| `todo` | Task backlog: `todo`, `todo <text>`, `todo rm <id>` |
| `npm run migrate` | Bring an existing install up to the current layout |

Providers are declared once in `claude_env_settings.json` and projected to both hosts.

## Go deeper

| Read | When you need |
|---|---|
| [`docs/setup.md`](docs/setup.md) | Adding a host, upgrading, plugins, LSPs, VS Code, output styles, notifications, troubleshooting |
| [`docs/providers.md`](docs/providers.md) | Provider schema, models, secrets, the Codex side |
| [`docs/operations.md`](docs/operations.md) | Hooks, `npm run doctor` checks, repo sync, memory & rules |
| [`docs/sync-architecture.md`](docs/sync-architecture.md) | Where every file lives and why |
| [`docs/bridge.md`](docs/bridge.md) | Telegram session bridge |
| [`docs/harness-architecture.md`](docs/harness-architecture.md) | Multi-machine collaboration design |
| [`AGENTS.md`](AGENTS.md) | Repo map for contributors and agents |
