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
- `npm run doctor` - Read-only invariant check. Every check maps to an incident that
  actually happened here (a hook wired but silently dead, payload/template shape drift,
  absolute machine paths in shared files, orphaned plugin installs, NUL bytes making a
  file binary to git). Exits 1 on failure; also runs at SessionStart via `--hook`,
  which reports failures only and is silent when healthy. Add a check here whenever a
  new silent-divergence incident is found — that is the point of the file.
- Public repo: doctor's `public-hygiene` check FAILs on personal data in any tracked file
  (home paths, real emails, Telegram chat ids, org cloud folders, plus the machine-local
  denylist `~/.claude/private-markers` — one literal or `/regex/` per line, never tracked;
  it lives in the sync dir so every fleet host shares it, linked by setup as an optional
  payload file, and doctor WARNs when a sync-dir host lacks it). `.githooks/pre-commit` runs it (`doctor.js --public-hygiene`); setup sets
  `core.hooksPath`. Exception: inline `public-hygiene: allow (<reason>)`.
- **Multi-machine only:** `node scripts/setup/setup.js --sync-dir "<path>"` points this
  host at the shared config payload and records `~/.claude/sync-dir`. Add
  `--init-sync-dir` on the FIRST machine to seed an empty payload dir from the templates;
  on later machines wait for the cloud client to finish downloading instead — setup
  refuses to seed a configured-but-empty dir, which would manufacture conflict copies.
  With no sync dir configured everything resolves inside the repo, exactly as before.
- `node scripts/setup/setup.js --machine <NAME>` writes the machine-local
  `~/.claude/machine.json` (one unique name per host).
  Read only via `scripts/shared/machine.mjs`;
  the Claude launchers and, for Codex, setup's composed `~/.codex/config.toml`
  `[shell_environment_policy.set]` turn it into committer provenance + `HARNESS_*` env
  (harness-architecture §8b; Codex commands may run in a shared daemon no launcher env reaches).
  Setup without the flag never overwrites it; doctor WARNs when it is missing.
- The working tree must NOT live inside a cloud-synced folder. See `docs/sync-architecture.md`.
- `npm run migrate` - Bring `~/.claude`/`~/.codex` symlinks, orphaned CLI aliases, and the
  current project's `.claude/` (cc-market plugin files) up to the latest format.
  `npm run migrate -- --dry-run` previews link/settings changes without writing. See `/migrate` skill.
  It no longer touches `enabledPlugins`: the retired-plugin swap it used to perform
  (`takeover` → `fabric`) can no longer match anything, since that plugin is gone from
  cc-market and the settings file is shared by every host.

## Architecture
Cross-platform Claude Code & Codex config sync. The working tree lives OUTSIDE any
cloud-synced folder and travels via git; only a three-file config payload rides cloud
storage. Both are linked into `~/.claude/` and `~/.codex/`. See `docs/sync-architecture.md`
— read it before touching anything path-related.
The multi-workstation / multi-task collaboration harness (lane = branch + worktree + main session, family process owned by lab-commons,
Telegram + remote control on the same live session, per-machine bridge in
`scripts/bridge/`) is designed in `docs/harness-architecture.md`.

### Structure
- `scripts/setup/`: `setup.js` (OS detection, symlinks), `install-cli-wrappers.js` (standalone cross-platform wrappers beside each host binary; no shell-profile dependency), `check-links.js` (shared self-heal for setup links — invoked by `scripts/hooks/setup-check-hook.js` on SessionStart and by both runtime launchers), `doctor.js` (the invariant checker — `npm run doctor`), `check-mac-notify.js` (macOS notification helper), `setup-vscode.js` (VS Code provider switching)
- `scripts/bridge/`: the per-machine session bridge (Telegram <-> live Claude/Codex sessions) — `daemon.mjs` (owns the bot token and the single `getUpdates` loop, maps session -> project group + Topic), `telegram.mjs` (Bot API client), `lifecycle.mjs` (the one session lifecycle for both hosts: open → idle-closed → reopened → ended → deleted), `topic-cache.mjs` (`topics.json`), `fleet.mjs` (the fleet report: each machine posts, in `bridge.fleet.order` and at a low rate, a rich-Markdown block per host that runs something or has a reset to act on — headroom verdict, run-out warning, account, quota table, running sessions; seats in `bridge.fleet.seats`), `extra-resets.mjs` (announced Codex/Claude extra resets from community APIs, shown as report state), host adapters emitting the same events — `codex-adapter.mjs` (client of the shared Codex app-server via `codex app-server proxy`, which carries **WebSocket** frames — `ws-stream.mjs`) and `claude-adapter.mjs` (127.0.0.1 IPC for the Claude channel and `bridge-hook.js`), `install-service.mjs` (`npm run bridge:install`: HKCU Run key / launchd / systemd --user), `ensure.mjs` (idempotent start-or-replace run on every session start — Claude SessionStart hook and `codex.js`; the daemon's exclusive `daemon.lock` makes concurrent starts safe). Its Claude half is the channel plugin `claude_plugins/session-bridge/`. Setup and config: `docs/bridge.md`
- `skills/migrate/`: `/migrate` skill — `migrate.js` (orphaned symlink cleanup + cc-market plugin `.claude/` migrations) and tests
- `scripts/runtime/`: `cc.js` / `codex.js` (provider launchers; both run `startup-sync.mjs` before loading repo code), `cc-launcher.mjs` / `codex-launcher.mjs` (pure env+args projection helpers — reused by `setup-vscode.js` so the two hosts cannot drift), `plugin-launcher.mjs` (resolves a plugin script inside the installed cache, used by the `todo` launcher), `win-spawn.mjs` (the Windows spawn shim), `todo-launcher.mjs`
- `scripts/shared/`: cross-host config helpers — `config.mjs` (`readMergedEnvSettings`, two-layer shared+local merge), `provider-keys.js` (single source of truth for the `ANTHROPIC_*` env-var strip list), `sync-dir.mjs` (resolves the payload dir: `$CLAUDE_SYNC_DIR` → `~/.claude/sync-dir` → repo root, and defines `SYNC_PAYLOAD_FILES`), `is-main.mjs` (the entry-point guard every script that is also a module must use — see Standard)
- ~~`scripts/migration/`~~: retired 2026-08-30 — all three hosts are on the split layout, so the one-time tooling (`migrate-host.mjs`, `rescue-clone.mjs`, the runbook, and the payload bootstrap copies) was archived to `.claude/memory/2026/08/30/.archive/`. See `.claude/memory/2026/08/30/host-migration-retired.md`; `docs/sync-architecture.md` still documents the layout itself.
- `scripts/hooks/`: `loop-guard-hook.js` (PreToolUse anti-spin guard — see Workflows),
  `sync-hook.js` (`--pull` on SessionStart, `--remind` on SessionEnd — see Workflows),
  `prune-cache-hook.js` (SessionStart: drops stale plugin-cache versions),
  `notify-hook.js` (cross-platform notifications), `hud-hook.js` (statusLine),
  `bridge-hook.js` (UserPromptSubmit + Stop + StopFailure: mirrors Claude prompts/final answers to the
  session bridge's Telegram Topic; PreToolUse + PostToolUse + Notification + SessionEnd drive the
  bridge's Claude state machine; PreToolUse(AskUserQuestion) relays the question and, in a
  Telegram-started turn, waits up to 10 min for the answer; silent no-op unless the bridge
  daemon runs — `docs/bridge.md`),
  `setup-check-hook.js` (SessionStart: verifies/heals setup links — recreates missing links,
  converts claude-hud config symlink→hard link, warns on drifted plain files with the
  `--replace` fix command; shared logic in `scripts/setup/check-links.js`, also run by
  `codex.js` since Codex has no session hooks)
- `system-prompt/`: per-host platform prompts (`claude-base.md`, `codex-base.md`). Linked to `~/.claude/system-prompt` and `~/.codex/system-prompt` so `fabric.systemPromptFile` / `codex_config.toml model_instructions_file` resolve through a per-host junction, not a hardcoded OneDrive path. See `.claude/memory/2026/08/11/system-prompt-paths-symlink.md`.
- `cc-market/`: the plugin marketplace (gitignored, its own repo — `DawnEver/cc-market`, cloned by setup). Four of its plugins are enabled and load-bearing here: `rem` (memory lifecycle, task engine `task-engine.js`, `/rem` + `/todo`), `sharp-review` (post-task review: hook, skill, workflow, findings sync via `post-review.js`), `evolve` (iterative review→fix loop), `fabric` (single-machine multi-provider calls — `call`/`fan_out` — and handoff; its cross-machine node feature is retired — see `docs/harness-architecture.md`). Three more are dormant — `watch`, `cc-latex`, `cc-academia` — present but not enabled. `traceme` is archived: disabled everywhere and not installed on any host (re-enable via `enabledPlugins` if needed). See `cc-market/AGENTS.md`
- `skills/`: Custom skills (`migrate`) — the whole dir is symlinked to
  `~/.claude/skills`. Codex needs each skill linked **individually**
  (`discoverCodexSkillLinks()` in setup.js, because `~/.codex/skills` also holds Codex's own
  built-in `.system` skills and cannot be replaced wholesale). Add new skills here as
  `skills/<name>/SKILL.md`; they are picked up automatically on both hosts.
  Account-level synced skills (`anthropic-skills:*`) are OFF — `syncClaudeAiSkills: false`
  in `claude_settings.json` — otherwise the CLI downloads them into `~/.claude/skills/synced`,
  i.e. straight into this repo. `.gitignore` carries `skills/synced/` as a backstop.
- `output-styles/`: Output styles (`<name>.md`, `keep-coding-instructions: false`) — symlinked to `~/.claude/output-styles`. Non-coding personas (e.g. `academic`) for terminal use; toggle via `/config` → Output style. Strips coding guidance, keeps the harness/tools. A full system-prompt replacement was rejected (degrades CC to a chatbox) — see `.claude/memory/2026/06/20/persona-vs-output-style.md`.
- `claude_plugins/`: Custom plugins (e.g., `claude-hud` config; `session-bridge` — the bridge's Claude channel MCP server, plain Node, registered by setup as user-scope MCP server `session-bridge` and loaded by `ccc` via `--dangerously-load-development-channels server:session-bridge`, see `docs/bridge.md`)
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
- `ccc` / `ccds` — Claude Code launchers (official / DeepSeek).
- `codc` / `cods` — Codex launchers (official / DeepSeek). `claude_env_settings.json` is the single provider source of truth for both hosts — see `docs/providers.md`.
- `todo` — Task management: `todo` (list), `todo <text>` (add), `todo rm <id>` (remove), `todo help`
- `install-cli-wrappers.js` installs `.cmd` plus Git Bash wrappers on Windows and executable shell wrappers on macOS/Linux. They live beside the matching host binary and never depend on PowerShell profiles, `.zshrc`, `.bashrc`, or `.ps1` scripts.

### Workflows
- Hooks wired in `claude_settings.json`: `SessionStart` runs `sync-hook.js --pull`
  (fast-forwards this checkout onto its upstream so a session starts from the
  freshest tree — startup only, silent when current, refuses rather than merging when
  the host has its own unpushed commits; a successful pull also re-runs `checkLinks()`
  because a pull replaces the `claude-hud` hard link, §10 of `docs/sync-architecture.md`),
  then `prune-cache-hook.js`, `setup-check-hook.js`
  (verifies/heals `~/.claude` symlinks via `scripts/setup/check-links.js` — recreates
  missing links, converts the `claude-hud` config symlink to a hard link, warns on
  drifted plain files). `SessionEnd` runs `sync-hook.js --remind` (uncommitted /
  unpushed report; the outbound half stays a deliberate user action — no auto-push).
  `Notification` runs `notify-hook.js`. `PreToolUse` (matcher `*`) runs
  `loop-guard-hook.js`: per-session anti-spin guard — it hashes each
  `(tool, normalized input)` inside a sliding window, and escalates on both exact
  repeats and near-duplicates (trigram-Jaccard). Defaults: identical calls warn on
  the 3rd via `additionalContext` and are denied from the 4th; near-duplicates warn
  on the 4th and are denied from the 5th. Polling-by-design tools (`Monitor`,
  `TaskOutput`, `ReadNotifications`, ...) are exempt and the hook fails open.
  Every knob is an env var settable from the `env` block of `claude_settings.json`:
  `CLAUDE_LOOP_GUARD_{WARN_AT,DENY_AT,SIMILAR_WARN_AT,SIMILAR_DENY_AT,
  SIMILAR_THRESHOLD,WINDOW_MINUTES,MAX_ENTRIES,EXEMPT,DISABLE}` — see `DEFAULTS`
  in the hook. The `Stop` hook runs the `sharp-review`
  plugin (post-task code review, 3 parallel reviewers).
- `~/.claude/` links to repo for sync
- `~/.codex/` links to repo for sync

### Standard
- **A script that is also a module must gate its entry point with `isMain(import.meta.url)`
  from `scripts/shared/is-main.mjs` — never `process.argv[1] === fileURLToPath(import.meta.url)`.**
  Node realpaths a module but not `argv[1]`, and every hook here is launched through the
  `~/.claude/scripts` link, so the naive comparison is always false in production: the body
  never runs and the process exits 0 in silence. That bug shipped twice — it disabled
  `loop-guard-hook.js` for two days and made `SETUP_FIX_CMD` a no-op. `npm run doctor` fails
  on any recurrence.
- After changes, update README and `setup.js` if needed
- **A skill's execution knowledge goes in its `SKILL.md` / `reference/*.md`, never in `rules/*` or `AGENTS.md`/`CLAUDE.md`.** At runtime a skill sees only its own files and the host project's config — never this repo's rules/`AGENTS.md`.
- Plugin development, tests, and marketplace conventions → see `cc-market/AGENTS.md`
- This repo is publicly available, but it is primarily intended for personal use and rapid iteration — backward compatibility is not a concern. Rename, restructure, or remove anything outdated rather than adding shims or compat layers.
