# Path Conventions — never name a machine-specific path in a shared file

The fleet has mixed usernames (`linxu` on G/WS2, **`ezxmb14`** on WS1), mixed OS, and mixed
drive letters. Two rules follow, and both have already caused live outages.

## 1. No absolute cloud/machine path in any shared or tracked file

Shared config names `~/.claude/...` or `~/.codex/...` and lets the per-host link resolve it.

- `fabric.systemPromptFile = "~/.claude/system-prompt/claude-base.md"`
- `codex_config.toml  model_instructions_file = "~/.codex/system-prompt/codex-base.md"`

`setup.js` creates those junctions (`CLAUDE_LINKS` / `CODEX_LINKS`), so the resolved path
contains no cloud folder and no username.

**Why:** these once hardcoded G's absolute OneDrive path. On WS1 that path does not exist,
and the CLI exited 1 at startup for *every* session there.

## 2. A git working tree NEVER lives in cloud storage

`.git` must be owned exclusively by one machine. A sync daemon replicating it produces
conflict copies of `index`/`FETCH_HEAD`, **overwrites `logs/HEAD` so the reflog is lost**,
and pushes divergent branches. This repo was migrated out of OneDrive on 2026-08-29 after
exactly that damage.

Layout:

| What | Where |
| --- | --- |
| working tree + `.git` | `~/Documents/Code/AI/cc-config` — **never** a synced folder |
| sync payload — `claude_settings.json`, `claude_env_settings.json`, `codex_config.toml` | the sync dir |
| API keys | `~/.claude/claude_env_settings.local.json` — machine-local, never synced |
| `models.json`, `system-prompt/dist/` | generated per machine |

Bulk local-only data (archives, PII transcripts) is a THIRD tenant: it belongs in neither
git nor the config payload. It lives in `<cloud>/Sync/agent-data/` and is joined back to a
working tree by gitignored symlinks — it needs backup, not version control. See the
`sync-restructure-three-tenancies` memory entry.

`resolveSyncDir()` (`scripts/shared/sync-dir.mjs`): `$CLAUDE_SYNC_DIR` → `~/.claude/sync-dir`
pointer → **repo root**. The repo-root default is what keeps a no-cloud install zero-config;
do not add cloud auto-detection.

**How to apply:** only `setup.js` and `check-links.js` resolve the sync dir. Everything else —
launchers included — reads through the `~/.claude/...` link. Full design:
`docs/sync-architecture.md`.

## 3. `~/.codex/config.toml` is composed, not linked

Codex writes `[projects.'<abs path>']` trust blocks, `[hooks.state.*]` and `[notice]` into its
own config. Only the hand-edited head is shared; setup composes the per-host file from
shared head + generated `[model_providers.*]` + this host's own state, and strips machine
state back out of the payload on every run. Never add those tables to the shared copy —
they will silently disappear.
