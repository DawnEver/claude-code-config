# AGENTS.md

<!--
  Boundary: This file covers the config-sync repo ONLY.
  For cc-market plugin development, see cc-market/AGENTS.md.
  Do NOT mix plugin details here.
-->

## Family flow
This repo is a dev-lab family member (`pyproject.toml` `[tool.dev_lab.*]`, no Python package). PRs from
`pr/*` merge into `integrate/main` through the forge; `main` is live (every host links into it, a push deploys
the dashboard) and moves only by the nightly `integrate promote`. Tests are `npm test`, posted as the `base`
part by `dev_lab.dev.commandpart`. Bootstrap with `uv sync --all-groups`, then install the family hooks once per
checkout: `.venv/Scripts/python -m dev_lab.dev.hook_install --install` (`.venv/bin/python` on POSIX). Workflows are
rendered (`python -m dev_lab.dev.ciworkflows render`) and `.gitignore`/`.gitattributes`/`.rgignore` too
(`python -m dev_lab.dev.famfiles --deltas scripts/_famconfig.py`): edit the TOML or the delta, never the output.

## Setup & Invariants
- `npm run setup` / `node scripts/setup/setup.js` — Initial and idempotent setup across `~/.claude`, `~/.codex`, and `~/.gemini/config` (where `~/.gemini` exists).
- `npm run doctor` — Read-only invariant checker (`scripts/setup/doctor.js`). Every check maps to a real silent-divergence incident (dead entry-point guards, payload/template drift, machine paths in synced files, rule-file truncation >24 KB, stale/unexecuted native hooks). At SessionStart `--hook` reports the last run's FAILs (`~/.claude/doctor-last.json`) and refreshes detached (`--hook-refresh` under `~/.claude/doctor-refresh.lock`, keeping every hook <5 s per D24). Add a check whenever a new silent-divergence class is found.
- **Public hygiene:** `doctor.js --public-hygiene` (also wired as the `public-hygiene` pre-commit row) FAILs on personal data in tracked files (home paths, real emails, Telegram chat ids, org cloud folders, plus the synced denylist `~/.claude/private-markers`). Exception: inline `public-hygiene: allow (<reason>)`.
- **Multi-machine sync:** `node scripts/setup/setup.js --sync-dir "<path>"` records `~/.claude/sync-dir` (`--init-sync-dir` seeds templates on the FIRST machine only; later machines wait for cloud download). Working tree MUST live outside any cloud-synced folder (`docs/sync-architecture.md`).
- **Provenance:** `node scripts/setup/setup.js --machine <NAME>` writes `~/.claude/machine.json` (read via `scripts/shared/machine.mjs`), projected into committer provenance + `HARNESS_*` env by launchers and Codex's composed `[shell_environment_policy.set]`.
- `npm run migrate` (`-- --dry-run`) — Cleans orphaned links/wrappers and migrates `.claude/` plugin files (`skills/migrate/`).

## Architecture
Cross-platform config sync & multi-host harness for **Claude Code**, **Codex**, and **Antigravity CLI (`agy`)**.
- Sync & path tenancy: `docs/sync-architecture.md` (read before touching anything path-related).
- Fleet collaboration harness, identity & bridge: `docs/harness-architecture.md` and `docs/bridge.md`.
- Providers & secrets: `docs/providers.md` (catalogue from `ai-lab` in `~/.claude/provider-cache.json`; keys in git credential store, never plaintext).
- Host integrations & telemetry: `docs/agy.md` (Antigravity), `docs/codex-harness-audit.md` + `docs/operations.md` (Codex), `docs/dashboard.md` (Cloudflare Worker + Mini App), `docs/usage.md` (D1 usage store).

### Structure
- `scripts/setup/`: `setup.js` (links for `~/.claude`, `~/.codex`, `~/.gemini/config`), `check-links.js` (link + config self-heal), `doctor.js` (invariants), `codex-config-compose.mjs` & `codex-hooks.mjs` (composed `~/.codex/config.toml` + merged `hooks.json`), `agy-config.mjs` (merges `cc-config` hook into `~/.gemini/config/hooks.json`, `cc-market` into `plugins.json`, and `agy-statusline.mjs` with `telemetry: true` into `~/.gemini/antigravity-cli/settings.json`; cleans legacy `session-bridge` MCP), `install-cli-wrappers.js`, `settings-hooks.mjs`, `setup-vscode.js`.
- `scripts/bridge/`: per-machine Telegram & dashboard daemon (`daemon.mjs`, `telegram.mjs`, `lifecycle.mjs`, `activity-board.mjs`, `context.mjs`, `jsonrpc.mjs`, `ensure.mjs`, `install-service.mjs`), host adapters (`claude-adapter.mjs` with `registerLocal`, `codex-adapter.mjs` over WebSocket `ws-stream.mjs`, `agy-adapter.mjs`), `send-attachment.mjs` (CLI attachment sender for Codex/agy/Claude), and collectors (`quota.mjs` + `quota-series.mjs` + `extra-resets.mjs`, `balances.mjs`, `resources.mjs`, `forges.mjs`, `hpc.mjs`, `dashboard-push.mjs`). Details: `docs/bridge.md`.
- `scripts/dashboard/`: Cloudflare Worker + Durable Object (`worker.mjs`, `api.mjs`, `auth.mjs`, `registry.mjs` persisted in DO KV, `notify.mjs`, `usage-store.mjs`, `deploy.mjs`) and Telegram Mini App (`public/`, shared `public/shared/vocab.mjs`). Wire schema: `scripts/shared/dashboard-schema.mjs`. Details: `docs/dashboard.md`.
- `scripts/usage/`: transcript parsers & incremental scanner (`transcripts.mjs`, `scan.mjs`, `push.mjs`, `query.mjs` via `npm run usage`). Details: `docs/usage.md`.
- `scripts/runtime/`: `cc.js` (`ccc`/`ccds`), `codex.js` (`codc`/`cods`), `agy.js` (`agyc`) + pure `*-launcher.mjs` helpers, `repo-automode.mjs` (`isTrustedRepo` + `.claude/automode.json` for `~/.claude/trusted-origins`), `win-spawn.mjs`, `todo-launcher.mjs`. All three host launchers spawn via `<recorded python> -m ai_lab.session` (`scripts/shared/session-launcher.mjs`).
- `scripts/hooks/`: `claude-hook.mjs` (single worker-thread entry per Claude event, <5 s D24), `codex-hook.mjs` (Codex native entry), `agy-hook.mjs` (Antigravity entry; `PreToolUse` always emits non-empty `decision`), `project-guard-bridge.mjs` (projects `agy` and `codex` events onto a `trusted-origins` repo's canonical `.claude/settings*.json` `deny-commands.js`, `hookdispatch`, and `permissions.allow` doors), `loop-guard-hook.js` (exact + trigram-Jaccard anti-spin guard), `sync-hook.js` (`--pull`, `--pull-background`, `--remind`, `boundedRepoReminder`), `bridge-hook.js`, `setup-check-hook.js`, `prune-cache-hook.js`, `notify-hook.js`, `hud-hook.js`, `agy-statusline.mjs`.
- `scripts/shared/`: `is-main.mjs`, `config.mjs`, `sync-dir.mjs`, `machine.mjs`, `seats.mjs`, `codex-home.mjs`, `agy-payload.mjs` (SSOT for agy prompt envelope & tool normalization), `provider-cache.mjs`, `session-launcher.mjs`, `session-identity.mjs`, `dashboard-schema.mjs`, `claude-defaults.mjs`, `channel-server.mjs`.
- **Configs & Assets:**
  - Sync payloads (gitignored, live in sync dir): `claude_settings.json`, `claude_env_settings.json`, `codex_config.toml` (hand-edited head only), seeded from `*.template.*`. Machine-local secrets: `~/.claude/claude_env_settings.local.json` (bridge/dashboard tokens only; API keys in git credential store).
  - `GLOBAL-AGENTS.md`: single global rules source linked to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/config/GEMINI.md`. Never write repo-specific memory there.
  - `cc-market/`: gitignored clone of `DawnEver/cc-market` (`rem`, `sharp-review`, `evolve`, `fabric` enabled; `watch`, `cc-latex`, `cc-academia` dormant). See `cc-market/AGENTS.md`.
  - `claude_plugins/`: `claude-hud` config; `session-bridge` (Claude channel MCP server).
  - `skills/`, `system-prompt/`, `output-styles/`, `keybindings.json`, `.claude/rules/rem/`, `.claude/memory/`.

### CLI Tools
- `ccc` / `ccds` (`ccc --seat <alias>`) — Claude Code launchers.
- `codc` / `cods` — Codex launchers.
- `agyc` — Antigravity CLI launcher (installed where `agy` is on PATH).
- `todo` — Task list CLI (`todo`, `todo <text>`, `todo rm <id>`).

### Standard
- **Every script that is also a module MUST gate its entry point with `isMain(import.meta.url)` from `scripts/shared/is-main.mjs` — never `process.argv[1] === fileURLToPath(import.meta.url)`.** Node realpaths a module but not `argv[1]`, so raw comparison through `~/.claude/scripts` links silently exits 0 without running. `npm run doctor` FAILs on any recurrence.
- **Rule files (`AGENTS.md`, `GLOBAL-AGENTS.md`) must stay well below 24,000 bytes** (`doctor` `rule-file-size` FAILs at 24,000 B, where Antigravity truncates rule files). Keep `AGENTS.md` concise and place subsystem details in `docs/*.md`.
- **A skill's execution knowledge goes in its `SKILL.md` / `references/*.md`, never in `rules/*` or `AGENTS.md`/`GLOBAL-AGENTS.md`.**
- No backward compatibility: rename, restructure, or remove outdated code directly rather than adding shims or aliases.
