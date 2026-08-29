# AGENTS.md

<!--
  Boundary: This file covers the config-sync repo ONLY.
  For cc-market plugin development, see cc-market/AGENTS.md.
  Do NOT mix plugin details here.
-->

## Setup
- `npm run setup` - Initial setup
- `node scripts/setup/setup.js` - Manual setup
- Re-run setup to verify (checks existing symlinks)
- **Multi-machine only:** `node scripts/setup/setup.js --sync-dir "<path>"` points this
  host at the shared config payload and records `~/.claude/sync-dir`. Add
  `--init-sync-dir` on the FIRST machine to seed an empty payload dir from the templates;
  on later machines wait for the cloud client to finish downloading instead — setup
  refuses to seed a configured-but-empty dir, which would manufacture conflict copies.
  With no sync dir configured everything resolves inside the repo, exactly as before.
- The working tree must NOT live inside a cloud-synced folder. See `docs/sync-architecture.md`.
- `npm run migrate` - Bring `~/.claude`/`~/.codex` symlinks, retired-plugin settings entries (e.g. takeover→fabric), and the current project's `.claude/` (cc-market plugin files) up to the latest format. `npm run migrate -- --dry-run` previews link/settings changes without writing. See `/migrate` skill.

## Architecture
Cross-platform Claude Code & Codex config sync. The working tree lives OUTSIDE any
cloud-synced folder and travels via git; only a three-file config payload rides cloud
storage. Both are linked into `~/.claude/` and `~/.codex/`. See `docs/sync-architecture.md`
— read it before touching anything path-related.

### Structure
- `scripts/setup/`: `setup.js` (OS detection, symlinks), `install-shell-aliases.js` (per-host wrapper install), `check-links.js` (shared self-heal for setup links — invoked by `scripts/hooks/setup-check-hook.js` on SessionStart and by `codex.js` since Codex has no session hooks), `fix-lsp-windows.js` (Windows LSP `.cmd` patch), `check-mac-notify.js` (macOS notification helper), `setup-vscode.js` (VS Code provider switching)
- `skills/migrate/`: `/migrate` skill — `migrate.js` (orphaned symlink cleanup + cc-market plugin `.claude/` migrations) and tests
- `scripts/runtime/`: `cc.js` / `codex.js` (provider launchers), `cc-launcher.mjs` / `codex-launcher.mjs` (pure env+args projection helpers), `aliases.sh`, `aliases.ps1`, `todo-launcher.mjs`, `traceme-launcher.mjs`
- `scripts/shared/`: cross-host config helpers — `config.mjs` (`readMergedEnvSettings`, two-layer shared+local merge), `provider-keys.js` (single source of truth for the `ANTHROPIC_*` env-var strip list)
- `scripts/migration/`: one-time per-host migration off the cloud-synced working tree — `migrate-host.mjs`, `rescue-clone.mjs`. Canonical copy; a bootstrap copy also lives in the sync payload dir because an un-migrated host runs it before cloning. See `scripts/migration/README.md` and `docs/host-migration-handoff.md`. Disposable once every host has migrated.
- `scripts/hooks/`: `notify-hook.js` (cross-platform notifications), `hud-hook.js`, `setup-check-hook.js` (SessionStart: verifies/heals setup links — recreates missing links, converts claude-hud config symlink→hard link, warns on drifted plain files with the `--replace` fix command; shared logic in `scripts/setup/check-links.js`, also run by `codex.js` since Codex has no session hooks)
- `system-prompt/`: per-host platform prompts (`claude-base.md`, `codex-base.md`). Linked to `~/.claude/system-prompt` and `~/.codex/system-prompt` so `fabric.systemPromptFile` / `codex_config.toml model_instructions_file` resolve through a per-host junction, not a hardcoded OneDrive path. See `.claude/memory/2026/08/11/system-prompt-paths-symlink.md`.
- `cc-market/sharp-review/`: Sharp review plugin — hook, skill, workflow, findings sync (`post-review.js`)
- `cc-market/rem/`: REM plugin — memory lifecycle, task management engine (`task-engine.js`), `/rem` and `/todo` skills
- `skills/`: Custom skills — symlinked to both `~/.claude/skills` and `~/.codex/skills`. Add new skills here as `skills/<name>/SKILL.md`; they are picked up automatically on both hosts.
- `output-styles/`: Output styles (`<name>.md`, `keep-coding-instructions: false`) — symlinked to `~/.claude/output-styles`. Non-coding personas (e.g. `academic`) for terminal use; toggle via `/config` → Output style. Strips coding guidance, keeps the harness/tools. A full system-prompt replacement was rejected (degrades CC to a chatbox) — see `.claude/memory/2026/06/20/persona-vs-output-style.md`.
- `claude_plugins/`: Custom plugins (e.g., `claude-hud`)
- `cc-market/`: Community plugin marketplace (gitignored, cloned by setup) — see `cc-market/AGENTS.md`
- `claude_settings.json`: Env vars, permissions, hooks (gitignored). **Sync payload** — lives in the sync dir, not the repo
- `claude_settings.template.json`: Template for new clones -> auto-copied to `claude_settings.json` by setup
- `claude_env_settings.json`: Non-secret provider config (base URLs, model pins) — **sync payload**, gitignored. NO API keys
- `claude_env_settings.template.json`: Desensitized provider template -> auto-copied to `claude_env_settings.json` by setup
- `claude_env_settings.local.template.json`: Desensitized per-machine secrets template -> copied by setup to `~/.claude/claude_env_settings.local.json` (a REAL machine-local dir, never cloud-synced). Each host fills in its own API keys there; all readers deep-merge local over shared
- `codex_config.toml`: **sync payload, hand-edited HEAD ONLY** (model, sandbox, TUI, plugins). Codex writes `[projects.*]` trust blocks / `[hooks.*]` / `[notice]` into its own config, so those are machine-local and must never sync. `~/.codex/config.toml` is therefore a REAL FILE composed per host by setup = shared head + generated `[model_providers.*]` + this host's own state — NOT a symlink. See `scripts/setup/codex-config-compose.mjs` and `docs/sync-architecture.md` § 3
- `models.json`: Codex model catalog (context window, reasoning levels, image input) — generated from `providers.<name>.models` on every setup run, linked to `~/.codex/models.json`. A build artifact: machine-local, gitignored, NEVER synced
- `codex_config.template.toml`: Desensitized Codex template -> auto-copied to `codex_config.toml` by setup
- `keybindings.json`: Claude Code keybindings -> synced to `~/.claude/keybindings.json`
- `GLOBAL-AGENTS.md`: Global guidelines, NEVER WRITE IN this repo's memory. Single source linked to both `~/.claude/CLAUDE.md` (Claude) and `~/.codex/AGENTS.md` (Codex global instructions)
- `.claude/rules/rem/`: All rules loaded every session (git-tracked), managed by REM plugin lifecycle. `.claude/rules/MEMORY.md` is the device-local generated index (gitignored).
- `.claude/memory/`: Historical reference — content git-tracked; access metadata in gitignored `_meta.json` per date directory. `MEMORY.md` index is device-local generated (gitignored). Findings stored as `sharp-review.md` per session — sole source of truth for tasks.

### CLI Tools
- `ccc` / `ccds` / `cckm` / `ccgmi` — Claude Code launchers (official / DeepSeek / Kimi / GMI Cloud), config in `claude_env_settings.json` under `providers.<name>`
- `cods` — Codex launcher (DeepSeek), same `providers.<name>` block. `claude_env_settings.json` is the single source of truth for both hosts — see `docs/providers.md`. GMI is Claude-only (Anthropic protocol); there is no `cogmi`.
- `todo` — Task management: `todo` (list), `todo <text>` (add), `todo rm <id>` (remove), `todo help`
- `traceme` — Personal observability: token/cost reports, multi-device sync
- `aliases.ps1` / `aliases.sh` — Shell integration; `setup.js` installs `.cmd` wrappers on Windows. Wrappers land next to the matching host binary (`ccc*` next to `claude`, `co*` next to `codex`); on a single-host install the other host's wrappers are skipped. `todo`/`traceme` go to whichever host's bin dir is on PATH (or to `codex`'s dir on a Codex-only install).

### Workflows
- Hooks wired in `claude_settings.json`: `SessionStart` runs `fix-lsp-windows.js`,
  `prune-cache-hook.js`, and `setup-check-hook.js` (verifies/heals `~/.claude`
  symlinks via `scripts/setup/check-links.js` — recreates missing links, converts
  the `claude-hud` config symlink to a hard link, warns on drifted plain files).
  `Notification` runs `notify-hook.js`. The `Stop` hook runs the `sharp-review`
  plugin (post-task code review, 3 parallel reviewers).
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- After changes, update README and `setup.js` if needed
- **A skill's execution knowledge goes in its `SKILL.md` / `reference/*.md`, never in `rules/*` or `AGENTS.md`/`CLAUDE.md`.** At runtime a skill sees only its own files and the host project's config — never this repo's rules/`AGENTS.md`.
- Plugin development, tests, and marketplace conventions → see `cc-market/AGENTS.md`
- This repo is publicly available, but it is primarily intended for personal use and rapid iteration — backward compatibility is not a concern. Rename, restructure, or remove anything outdated rather than adding shims or compat layers.
