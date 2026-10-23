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

Configure provider credentials through the credential store described in
[`docs/providers.md`](docs/providers.md); do not put API keys in the shared payload.
For Codex, review the newly installed native definitions with `/hooks`. Setup never
auto-trusts hooks. Plugin source changes require a normal plugin release/update before
an already-installed marketplace cache contains them.
Native startup/tool hooks also preserve snapshot-protected cache files removed by vendor
cleanup; this is recovery, not deletion or a guarantee of atomic native cache updates.

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
| [`docs/providers.md`](docs/providers.md) | Provider projection: the ai-lab catalogue cache, keys in the credential store, the Codex side |
| [`docs/operations.md`](docs/operations.md) | Hooks, `npm run doctor` checks, repo sync, memory & rules |
| [`docs/sync-architecture.md`](docs/sync-architecture.md) | Where every file lives and why |
| [`docs/bridge.md`](docs/bridge.md) | Telegram session bridge |
| [`docs/dashboard.md`](docs/dashboard.md) | Agents Dashboard: read-only Telegram Mini App over every host's sessions |
| [`docs/harness-architecture.md`](docs/harness-architecture.md) | Multi-machine collaboration design |
| [`docs/codex-harness-audit.md`](docs/codex-harness-audit.md) | Codex support checklist: working integrations, partial behavior and missing wiring |
| [`AGENTS.md`](AGENTS.md) | Repo map for contributors and agents |
