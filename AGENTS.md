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
rendered (`python -m dev_lab.dev.ciworkflows render`) and `.gitignore`/`.gitattributes` too
(`python -m dev_lab.dev.famfiles --deltas scripts/_famconfig.py`): edit the TOML or the delta, never the output.

## Setup & Invariants
- `npm run setup` / `node scripts/setup/setup.js` — Initial and idempotent setup across `~/.claude`, `~/.codex`, and `~/.gemini/config` (where `~/.gemini` exists).
- `npm run doctor` — Read-only invariant checker (`scripts/setup/doctor.js`). Every check maps to a real silent-divergence incident (dead entry-point guards, payload/template drift, machine paths in synced files, rule-file truncation >24 KB, stale/unexecuted native hooks). At SessionStart `--hook` reports the last run's FAILs (`~/.claude/doctor-last.json`) and refreshes detached (`--hook-refresh` under `~/.claude/doctor-refresh.lock`, keeping every hook <5 s per D24). Add a check whenever a new silent-divergence class is found.
- **Public hygiene:** `doctor.js --public-hygiene` (also wired as the `public-hygiene` pre-commit row) FAILs on personal data in tracked files (home paths, real emails, Telegram chat ids, org cloud folders, plus the synced denylist `~/.claude/private-markers`). Exception: inline `public-hygiene: allow (<reason>)`.
- **Multi-machine sync:** `node scripts/setup/setup.js --sync-dir "<path>"` records `~/.claude/sync-dir` (`--init-sync-dir` seeds templates on the FIRST machine only; later machines wait for cloud download). Working tree MUST live outside any cloud-synced folder (`docs/sync-architecture.md`): a sync daemon conflict-copies `.git/index`, overwrites `logs/HEAD` (the reflog is lost) and pushes divergent branches — this repo left OneDrive on 2026-08-29 after exactly that.
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
  - `GLOBAL-AGENTS.md`: single global rules source linked to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/config/GEMINI.md`. Never write repo-specific memory there, and never hand-edit it for a project change: it applies to every project on every host; project changes go in this `AGENTS.md`.
  - cc-market (`DawnEver/cc-market`; `rem`, `sharp-review`, `evolve`, `fabric` enabled; `watch`, `cc-latex`, `cc-academia` dormant) is a family repo checked out beside the others, declared in the machine file `[repos] cc-market` and read by `scripts/shared/market-dir.mjs`; never a clone inside this repo (two clones drift). Commit plugin changes in that checkout (`git -C <declared cc-market checkout> ...`); `~/.claude/plugins/marketplaces/cc-market` and `~/.claude/plugins/cache/cc-market/` are the installed copies and lag it until it lands. See its own `AGENTS.md`.
  - `claude_plugins/`: `claude-hud` config; `session-bridge` (Claude channel MCP server).
  - `skills/` (every custom skill and agent is written to `skills/<name>/SKILL.md` here, linked to `~/.claude/skills` and `~/.codex/skills` — never into `~/.claude/` or the plugin cache), `system-prompt/`, `output-styles/`, `keybindings.json`, `.claude/memory/`.

### CLI Tools
- `ccc` / `ccds` (`ccc --seat <alias>`) — Claude Code launchers.
- `ccla` — Claude Code on a local llama.cpp model (ai-lab `llamacpp`; server started on demand, session local-only: no bridge mirror, MCP or web tools). Setup: ai-lab `docs-src/local-llama.md`.
- `codc` / `cods` — Codex launchers.
- `agyc` — Antigravity CLI launcher (installed where `agy` is on PATH).
- `todo` — Task list CLI (`todo`, `todo <text>`, `todo rm <id>`).

### Standard
- **Every script that is also a module MUST gate its entry point with `isMain(import.meta.url)` from `scripts/shared/is-main.mjs` — never `process.argv[1] === fileURLToPath(import.meta.url)`.** Node realpaths a module but not `argv[1]`, so raw comparison through `~/.claude/scripts` links silently exits 0 without running. `npm run doctor` FAILs on any recurrence.
- **Rule files (`AGENTS.md`, `GLOBAL-AGENTS.md`) must stay well below 24,000 bytes** (`doctor` `rule-file-size` FAILs at 24,000 B, where Antigravity truncates rule files). Keep `AGENTS.md` concise and place subsystem details in `docs/*.md`.
- **A skill's execution knowledge goes in its `SKILL.md` / `references/*.md`, never in `AGENTS.md`/`GLOBAL-AGENTS.md`.**
- No backward compatibility: rename, restructure, or remove outdated code directly rather than adding shims or aliases.
- **No machine path in a tracked or synced file.** Shared config names `~/.claude/...` / `~/.codex/...` and the per-host links (`CLAUDE_LINKS` / `CODEX_LINKS` in `setup.js`) resolve it; one host's hardcoded cloud path once made the CLI exit 1 at startup for every session on another host. Only `setup.js` and `check-links.js` resolve the sync dir; everything else reads through the link, except the one write, `applyConfigChange` (`docs/sync-architecture.md`). Bulk local-only data (archives, PII transcripts) is a third tenant in `<cloud>/Sync/agent-data/`, joined back by gitignored symlinks — neither git nor the payload.
- **`~/.codex/config.toml` is composed, not linked:** never add `[projects.*]`, `[hooks.state.*]` or `[notice]` to the shared head — setup strips them back out and they silently disappear.
- **Commits:** imperative conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), multi-line messages through a Bash heredoc — a PowerShell here-string leaks `@` into the message. Never force-push a shared branch.

<!-- BEGIN dev-lab family section -->

## Family principles

_Rendered by `dev_lab.dev.agentsection` from `dev_lab.dev.principles`; a hand edit here is refused._

- **First principles** (`first-principles`): Derive from the actual system and current needs, not habit or precedent;
  state shaping assumptions.
- **Discard historical baggage** (`no-historical-baggage`): Remove obsolete structures, duplicates and dead paths no
  current need uses -- never a capability.
- **Occam's razor** (`occams-razor`): Simplest design meeting the need; nothing hypothetical; never a capability.
- **Single source of truth** (`single-source-of-truth`): Each fact lives in one place; all else derives from it.
- **Layered decoupling** (`layered-decoupling`): Depend one way through narrow interfaces; never into internals or
  upward.
- **Names match what they do** (`names-match-behavior`): A name says what the thing does now.
- **No backward compatibility** (`no-backward-compatibility`): No shims, aliases or dual paths for old callers; callers
  move with the change.
- **Progressive disclosure** (`progressive-disclosure`): An entry point states what is needed first and points to
  detail; no duplication across levels.
- **Keep every valuable parameter and option** (`keep-valuable-options`): Generality is a requirement: keep every
  parameter and option a real case uses or plausibly needs. A reference match ADDS a selectable option and never
  replaces or deletes the alternative; numerical method choices are options even with no current caller.
- **Every wall teaches** (`every-wall-teaches`): Every refusal or failure an agent hits names its cause and its door;
  one that does not is a mechanism gap, and closing it (a hook row, a remedy, a test) comes before the task. Never route
  around a wall or hand the user a command. The loop: docs-src/dev/feedback.md.
- **Fan out without a barrier** (`no-barrier-fan-out`): Parallel work is independent items, each landed the moment it is
  done; nothing waits for the slowest sibling -- no barrier-style orchestration (e.g. a dynamic workflow that joins all
  agents) unless a step truly needs every result. How: docs-src/dev/fanout.md.
- **Deliver an image by its absolute path** (`images-by-absolute-path`): An image handed to the user is named by its
  ABSOLUTE path, never a relative one (IMAGES-BY-ABSOLUTE-PATH).
- **A worktree is named for its task** (`worktree-names-its-task`): A worktree's name has a physical meaning tied to its
  task; a hash-like name (`agent-<hex>`, an appended hash) is forbidden (WORKTREE-NAMES-ITS-TASK).
- **Native first** (`native-first`): Python declares and orchestrates, Rust computes. A stage Rust owns is written in
  Rust from its first line; a Python version of it is only a scratch prototype, never a second implementation;
  acceptance is against references (analytic, the vendor ladder, the previous implementation during a migration), never
  against a Python twin.

## Family workflow

_Each rule is cited by ID; its full statement and refusing mechanism live in `dev_lab.dev.rules`._

- `SHARED-CHECKOUT`: A box holds a SHARED, possibly concurrent checkout: there is NO single-agent mode, the remote IS
  the only shared medium, pushing is the obligation rather than the last step of landing, and a verdict cannot be
  delegated to someone who cannot see the code.
- `ONE-BRANCH-PER-SESSION`: The integration branch is the only long-lived branch a session works into: a pushed head is
  `pr/<task-slug>/<feature>`, one feature per PR, and every other branch is merged and then deleted, never left behind;
  a repo`s long-lived branches are DECLARED (the trunk plus the integration branch) so anything else on origin or on
  this box is debt, and unpushed work is reported, never deleted silently.
- `PRS-TARGET-INTEGRATION`: Every pull request targets the integration branch, one opened against the trunk is
  retargeted with a comment saying why, and each child branch carries ONE integration comment (or, without a PR, one
  `integration` commit status) updated in place by `forge integration`, never a new one per tick.
- `DOWNSTREAM-SYNCS-INTEGRATION`: A child branch (a lane, a feat branch, a pull-request head) merges ONLY the
  integration branch, so another child`s work reaches it once, through integration, unless the owner opts in to watch
  named refs recorded in the checkout`s own git config (`branch.<child>.labSyncFrom`), never in a file, and `forge sync`
  merges integration first, then the watched refs, refusing any other ref by name.
- `SUBAGENT-NO-PUSH`: A subagent never publishes (no push, no PR opened or readied, no skipped hook): it commits on its
  lane and hands the SHA back to the main session, which merges and pushes, the forge produces the verdict
  (VERDICTS-FROM-THE-FORGE), and a targeted measure of the tests it touched stays its own.
- `VERDICTS-FROM-THE-FORGE`: A verdict is a fact about (tree, env key, part), produced ONCE after the push by the forge
  serve host that claims its `tests/<part>` part and read from the forge: no pre-push hook runs a test, a full tier
  refuses outside the producer naming the remedy (push, then read the part), a targeted measure needs no claim, and a
  producer cites a stored PASS of its key rather than re-run.
- `TRUNK-MOVES-BY-FAST-FORWARD`: The trunk moves only by fast-forward to an integration commit whose every required
  `tests/<part>` part stands PASS at scope full, through `integrate promote`; it refuses with the missing parts named
  and the emergency door, and refuses a trunk that cannot fast-forward rather than merging into it.
- `MERGE-OR-DELETE`: A merged branch is DELETED and an unmerged one is MERGED, no third state: an `archive/*` tag or
  untracked rename hides work and is debt -- `branchset` lists it, deletes it when a declared branch holds its tip, else
  names it to merge.
- `AGENT-GUARD`: A hand-written test invocation, a bare network git verb and a stash are refused by the shared deny
  machinery rather than by prose, so the refusal is identical in every repo that adopts it.
- `NETWORK-RETRY-THEN-REPORT`: The forge is a REMOTE service: a network verb goes through the retry wrapper rather than
  being called directly, and a write that still fails is REPORTED with its diagnosis instead of hammered.
- `PRODUCTION-ENTRY-POINT`: Reproduce a behavior through the PRODUCTION entry point, never an ad-hoc script handed out
  beside it, and treat a behavior not reachable from there as a gap to FIX, the boundary being the SUBJECT, not the tree
  the code happens to live in.

<!-- END dev-lab family section -->
