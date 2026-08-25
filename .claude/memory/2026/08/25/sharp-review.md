---
name: sharp-review-2026-08-25
description: Sharp review findings — 45 total
metadata:
  type: project
---




## Status (as of 2026-08-25, post-fix pass)

- **Fixed: 32** (4 by an earlier subtask fork + 18 in the docs pass + 10 in the security/diff pass)
- **Deferred: 13** (multi-file refactors or security-sensitive — see "Deferred" below)

### Fixed in this round

- **SR-018 [HIGH]** providers.md stale local-file example — replaced `env:<provider>` example with `providers.<name>.apiKey`
- **SR-019 [MEDIUM]** providers.md migration callout — added "Migrating from the legacy `env:<provider>` shape" subsection with before/after and failure modes
- **SR-020 [MEDIUM]** README codex TOML precondition — added to "Caveat for codex-side aliases" paragraph
- **SR-021 [LOW]** providers.md claudeExtras string-only — added the "string" qualifier; non-string entries silently dropped
- **SR-022 [LOW]** providers.md co/cokm ambiguity — clarified that `co` = codex-default and `cokm` = codex+kimi
- **SR-023 [HIGH]** README SessionStart hooks — added the three SessionStart rows + a paragraph on what `check-links.js` auto-repairs and that `codex.js` runs the same check
- **SR-025 [HIGH]** AGENTS.md Workflows section — corrected to Notification only, mentioned SessionStart chain
- **SR-026 [MEDIUM]** README gitignore claim — corrected the table + prose to quote the actual `**/.claude/**` pattern; noted `MEMORY.md` and `_meta.json` are device-local
- **SR-027 [MEDIUM]** README mojibake + BOM — replaced `鈮?` with `>=` (REM thresholds, 20-entry threshold); stripped the leading UTF-8 BOM
- **SR-028 [MEDIUM]** AGENTS.md setup/ sparse bullet — expanded to enumerate `setup.js` / `install-shell-aliases.js` / `check-links.js` / `fix-lsp-windows.js` / `check-mac-notify.js` / `setup-vscode.js`
- **SR-029 [MEDIUM]** AGENTS.md codex_config.toml missing — added `codex_config.toml` / `codex_config.template.toml` to Structure with the `[model_providers.<id>]` precondition
- **SR-030 [MEDIUM]** README npm scripts — added `npm run setup` / `npm test` to Setup section; added a new "Upgrading an existing install" subsection for `npm run migrate`
- **SR-031 [MEDIUM]** README hardlink info — added a paragraph noting `claude-hud` is always hard-linked by design + EXDV same-volume requirement
- **SR-032 [LOW]** setup.js cokm typo — corrected to `cckm` in the migration nudge
- **SR-033 [LOW]** setup.js agents/ link — dropped the `agents/` entry from `CLAUDE_LINKS` (dir doesn't exist; was a permanent SKIP). Empty top-level `rules/` dir cleanup deferred — `rm -rf` requires explicit user confirmation.
- **SR-034 [LOW]** README rem/sharp-review note — qualified as fresh-install behavior; existing installs use `npm run migrate`
- **SR-035 [LOW]** README Codex link — corrected to `https://github.com/openai/codex`

### Fixed by earlier subtask fork

- **SR-012 [LOW]** setup.js stale `.claude/workflows` link — removed from `CLAUDE_LINKS`
- **SR-014 [LOW]** providers.md historical-decision bloat — "ChatGPT bridge — removed" moved to `.claude/memory/2026/08/25/chatgpt-bridge-removed.md`; dead `cokm` mention also removed
- **SR-016 [LOW]** fabric/engine/providers.mjs header — corrected to state the file lives in `fabric/engine/` (not bundled)
- **SR-017 [LOW]** AGENTS.md Structure — added `scripts/shared/` and `system-prompt/` bullets

### Deferred (require multi-file refactors or user decision)

- **SR-001 [HIGH]** cc-market/shared/ vendoring — 48-file duplication; needs package-publish or pre-commit re-bundle
- **SR-002 [HIGH]** stale worktree at `cc-market/.claude/worktrees/agent-a5a6504c62ff45634` — `rm -rf` is destructive; needs user confirmation. Cleanup command when ready: `git -C cc-market worktree prune && rm -rf cc-market/.claude/worktrees`
- **SR-003 [HIGH]** `cc-market/fabric/scripts/mcp-server.mjs` 958-line monolith — split into dispatch/ tools/ present/
- **SR-004 [HIGH]** `cc-market/rem/scripts/lib.mjs` 600-line hub — split into scopes/frontmatter/meta/paths; defer import-time side effects
- **SR-005 [HIGH]** `cc-market/fabric/engine/session.mjs` 629-line — extract teams.mjs and attach.mjs
- **SR-006 [MEDIUM]** deepMerge duplication — fabric/engine/providers.mjs and scripts/shared/config.mjs have separate deepMerge. Needs fabric reader update in a separate repo.
- **SR-007 [MEDIUM]** pre-push-only `shared/` re-bundling — needs pre-commit hook rewiring
- **SR-008 [MEDIUM]** `fabric.token` in synced file — security-sensitive; needs user decision on per-machine distribution
- **SR-009 [MEDIUM]** four >600-line test files — `node-fabric.test.mjs` (1459), session (867), task-lib (769), lib (742) — split by subsystem
- **SR-010 [MEDIUM]** `cc-market/traceme/scripts/commands/dashboard.mjs` 565-line — move embedded JS to a real .js asset
- **SR-011 [MEDIUM]** `cc-market/fabric/web/public/main.js` 859-line — split conveyor / chat / polling
- **SR-013 [LOW]** rem/scripts/lib.mjs import-time side effects — convert to lazy getters; covered by SR-004's larger split
- **SR-015 [LOW]** four SKILL.md over 100 lines (evolve 121, sharp-review 119, watch 114, refresh-docs 109) — trim bodies, push detail to `reference/*`

## Review 2026-08-25 (session) — diff review + architecture survey (架构锐评)

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): FAILED
- Reviewer deepseek (deepseek): OK
- Reviewer gmi (gmi): skipped
- Reviewer kimi (kimi): skipped
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20260825-001] [HIGH] cc-market/shared/ — shared/ is vendored into 7 plugin-local copies (48 duplicated files) with a push-time-only sync; deepMerge/findProjectRoot/readStdinJSON are re-implemented 9-10 times across the repo

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Treat cc-market/shared/ as a publishable package and have plugins depend on it at install time, or keep the vendored-copy design but (a) run bundle_shared + bundle-integrity as a pre-commit step, not pre-push, and (b) stop bundling into plugins that don't import it (cc-latex).

The pre-push hook bundles shared/*.mjs into every plugin that has plugin.json, so the working tree is consistent only at push time: a commit touching shared/ records stale copies in the commit that pre-push later amends. cc-latex receives a bundled shared/ but its production code never imports it (bundle-integrity test filters it out via usesShared()), so it's dead weight. Outside the bundle, the same config-merge convention is re-implemented in scripts/shared/config.mjs and cc-market/fabric/engine/providers.mjs (each has its own deepMerge), and rem/scripts/lib.mjs adds a 9th findProjectRoot wrapper. One edit in shared/lib.mjs is one edit in 8 places to stay consistent.

---

### [SR-20260825-002] [HIGH] cc-market/.claude/worktrees/agent-a5a6504c62ff45634 — Stale 2.1MB orphaned git worktree (June 19, unregistered, gitignored) containing full copies of 6 plugins

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the directory: git -C cc-market worktree prune && rm -rf cc-market/.claude/worktrees.

This worktree is not in `git worktree list` (no .git/worktrees registration) but is a full snapshot of evolve/rem/sharp-review/traceme/takeover/watch from 2 months ago. It is git-ignored so never committed, but it is a dead subsystem that bloats the synced directory, doubles the search surface for any future worktree cleanups, and contains stale code that tooling or a future reviewer could mistake for live.

---

### [SR-20260825-003] [HIGH] cc-market/fabric/scripts/mcp-server.mjs — 958-line monolith: 6 provider-mode dispatch functions, the MCP tool router, and ~100 lines of inline fleet/session formatting (sessionLine/machineLine) all in one module

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split into dispatch/ (one module per mode or a callers table), tools/ (one handler per MCP tool), and present/ (list_nodes formatting). The lib/ and engine/ seams already exist — mcp-server.mjs should only wire them.

handleToolCall (line 700) contains the entire tool surface including inline presentation logic (lines 843-900) for node status lines, memory formatting, and dedup. Any new MCP tool or new provider mode forces edits to the same function; the module is already near the 1000-line mark and is the fabric plugin's main entry point.

---

### [SR-20260825-004] [HIGH] cc-market/rem/scripts/lib.mjs — 600-line grab-bag hub (16 importers) mixing scope discovery, frontmatter parsing, date helpers, memory meta/state, and index constants — plus import-time side effects (findProjectRoot/findMemoryScope run at module load)

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split into scopes.mjs, frontmatter.mjs, meta.mjs, paths.mjs; move repoRoot/memoryDir/scopeRoot computation behind lazy getters or explicit init so importing the module does not depend on cwd.

Exports at lines 18-23 and 108-111 execute findProjectRoot()/findMemoryScope() at import time, coupling every importer (rem-hook, task-engine, todo, doc-freshness) to the process cwd — a latent source of wrong-path bugs for a multi-project CLI. The module is simultaneously a barrel (re-exports formatIndexEntry/parseIndex from shared with aliases) and a 600-line implementation, so its responsibilities are not discoverable from the module boundary.

---

### [SR-20260825-005] [HIGH] cc-market/fabric/engine/session.mjs — 629-line session registry that also owns the team registry, attach/dedup, goal/compact, and liveness refresh — above the 600-line split rule

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Extract the team registry (lines 552-626) into teams.mjs and the remote attach machinery (lines 355-433) into attach.mjs; leave session.mjs with create/send/close/list/view only.

The module has two distinct registries (sessions Map and teams Map) plus attach inflight tracking and periodic refresh timers. These have different lifecycle rules (teams are fleet-of-workers, sessions are MCP-server-held) and different test surfaces, but are co-located only because they share the openProviderSession seam.

---

### [SR-20260825-006] [MEDIUM] scripts/shared/config.mjs — The provider-registry deep-merge convention is duplicated between the main repo (config.mjs) and the fabric plugin (engine/providers.mjs) — the file itself says 'Keep the two in step'

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Since fabric/engine/providers.mjs is the richer reader (model aliases, foundry normalization, per-machine overlay), have scripts/shared/config.mjs delegate to it (or publish the merge from cc-market/shared) instead of maintaining a second deepMerge + readMergedEnvSettings.

Both implement override-wins deepMerge over claude_env_settings.json + ~/.claude/claude_env_settings.local.json. Two independent sources of truth for the same convention will drift (they already differ in provider-key coverage: providers.mjs lists ~20 env keys, config.mjs reads none). A subtle merge-behavior change in one is invisible to the other.

---

### [SR-20260825-007] [MEDIUM] cc-market/scripts/git-hooks/pre-push — shared/ re-bundling happens only on push, so every commit and every clone-at-commit carries stale plugin-local copies; the integrity test can't catch what pre-commit never re-bundles

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Run bundle_shared in the pre-commit hook (before tests), so the committed tree is always consistent and bundle-integrity actually validates the staged state; drop the pre-push-only amortization or keep it as a no-op fast path.

Editing shared/lib.mjs then committing produces a commit whose 7 plugin copies are stale; pre-push amends it and re-bundles. Any intermediate state (crash before push, WIP branch pushed by another machine, git bisect) sees inconsistent copies. The pre-commit hook already runs bundle-integrity when shared/ is staged — but it verifies the tree BEFORE rebundle, so it validates stale copies against stale copies.

---

### [SR-20260825-008] [MEDIUM] claude_env_settings.json — fabric.token and node fingerprints (a long-lived peer-auth credential) live in the OneDrive-synced shared settings file, contradicting the repo's own 'NO API keys / no secrets in the synced file' rule

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move fabric.token into ~/.claude/claude_env_settings.local.json (per-machine) with a documented distribution step for the 3 known nodes, or at minimum document that fabric.token is an explicit exception to the providers.md rule and give it a rotation path.

providers.md states claude_env_settings.json 'must NOT carry API keys' because it rides OneDrive; the fabric block carries a live peer token (Y7k2_...) and per-host fingerprints for the LAN mesh. The file is git-ignored so it never enters git history, but OneDrive sync to every machine is a real distribution channel for a credential that is never rotated and is shared verbatim in plaintext.

---

### [SR-20260825-009] [MEDIUM] cc-market/fabric/tests/node-fabric.test.mjs — Four test files exceed 600 lines (node-fabric 1459, session 867, task-lib 769, lib 742) — integration tests accumulating in single files

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split node-fabric.test.mjs by subsystem (auth, session lifecycle, teams, config/merge, JSON-RPC framing); apply the same to the other >600 test files so a failing suite localizes a module.

node-fabric.test.mjs is a 1459-line sequence of ~30 integration scenarios. It has no describe() grouping (flat test() list), making failure output hard to attribute and parallel sharding impossible. The review rule (>600 lines must be split) applies to code files; these are the largest files in the repository.

---

### [SR-20260825-010] [MEDIUM] cc-market/traceme/scripts/commands/dashboard.mjs — 565-line dashboard monolith that embeds ~360 lines of browser JS as a template string inside the HTML builder

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move the client-side app out of the template string into a real .js asset (served or read at build time), so it can be linted, tested, and syntax-checked; keep buildDashboardHtml thin.

Lines 130-489 embed the client app verbatim inside a template literal. The embedded JS is invisible to node --test, linting, and the parser — a syntax error there only surfaces at runtime in the browser. This is the classic server-rendered-string antipattern for a codebase that otherwise has a proper web/ frontend (fabric/web).

---

### [SR-20260825-011] [MEDIUM] cc-market/fabric/web/public/main.js — 859-line console frontend orchestration monolith (polling, conveyor stages, click dispatcher, chat) above the 600-line split rule

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split the conveyor/choreography from the chat component and the polling/refresh state machine; state.js already owns derivation, so main.js should shrink to boot + wiring.

main.js is the largest frontend file and mixes boot, polling guards, stage switching, and the chat render loop in one closure. Unlike state.js/render.js (which are properly separated), main.js has no internal decomposition — it is the fabric console's equivalent of a 900-line App.tsx.

---

### [SR-20260825-012] [LOW] scripts/setup/setup.js — Line 28 links '.claude/workflows' which no longer exists in the repo — silently skipped on every setup run; AGENTS.md also documents .claude/workflows/ as present

- **Category:** Bug
- **Status:** FIXED (2026-08-25, by earlier subtask fork — link entry removed from CLAUDE_LINKS; AGENTS.md bullet removed)
- **Confidence:** single-reviewer
- **Suggestion:** Remove the .claude/workflows entry from CODEX_LINKS/CLAUDE_LINKS and the matching AGENTS.md bullet, or re-create the workflows dir if the feature is intended.

linkEntry() skips missing src ('source not found'), so the stale entry is a permanent no-op that misleads readers of setup.js and AGENTS.md into thinking workflow scripts are synced. No workflows/ directory exists in the repo or in .claude/.

---

### [SR-20260825-013] [LOW] cc-market/rem/scripts/lib.mjs — Import-time filesystem side effects (repoRoot/scopeRoot at lines 18-23, 108-111) make module loading cwd-dependent for a multi-project CLI

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Convert module-level path constants to functions or lazy getters, and have scripts call init() with the resolved project root once.

Any process importing rem/scripts/lib.mjs resolves .claude/memory, .claude/rules, and scopeRoot relative to process.cwd() at import time. The todo CLI and hooks run from arbitrary project dirs; if import order ever differs from the current-project expectation, all path constants are silently wrong. This is a landmine for any future embedding of rem logic.

---

### [SR-20260825-014] [LOW] .claude/rules/rem/providers.md — Always-loaded rules carry one-off historical decisions and mechanism: 'ChatGPT Bridge — REMOVED, do NOT re-add' with a deletion inventory; hook.md holds a known-bug note; migration.md documents tooling mechanics

- **Category:** Feature
- **Status:** FIXED (2026-08-25, by earlier subtask fork — ChatGPT-bridge section moved to `.claude/memory/2026/08/25/chatgpt-bridge-removed.md`)
- **Confidence:** single-reviewer
- **Suggestion:** Move the ChatGPT-bridge deletion history and the hook state-carryover bug note into .claude/memory/ (one-off decisions); keep only the forward-looking principles in the always-loaded rules.

Per the repo's own progressive-disclosure rule, always-loaded docs should hold core development principles. providers.md's 'What was deleted (do NOT restore)' section and hook.md's 'Known issues' bug report are retrospective decisions with no forward-looking enforcement value — they tax every session and belong in memory entries.

---

### [SR-20260825-015] [LOW] cc-market/evolve/skills/evolve/SKILL.md — Four SKILL.md files sit just over the 100-line disclosure threshold (evolve 121, sharp-review 119, watch 114, refresh-docs 109) with detailed procedural content in the always-loaded body

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Trim the always-loaded bodies to the execution path and move the PowerShell command sequences, squash protocol, and interruption-guard mechanics into reference/* — the reference dirs already exist and are the intended home.

These are borderline, not egregious: sharp-review already pushes schema/weights to reference/profiles-and-modes.md, and evolve links round-protocol.md. But the main bodies still carry multi-step setup sequences (e.g. evolve's squash soft-reset recipe) that load on every /evoke invocation regardless of whether they're needed.

---

### [SR-20260825-016] [LOW] cc-market/fabric/engine/providers.mjs — Header comment claims 'Bundled into every plugin's shared/ by the pre-push hook' but providers.mjs is not in shared/ — a stale comment from the takeover merge

- **Category:** Bug
- **Status:** FIXED (2026-08-25, by earlier subtask fork — header updated to state the file lives in `fabric/engine/`)
- **Confidence:** single-reviewer
- **Suggestion:** Update the header to state where providers.mjs actually lives (fabric/engine) and that only shared/*.mjs is bundled.

The comment is a leftover from the engines-into-shared refactor. Only attention/lib/lock/spawn/stamp/state are bundled into plugin shared/ dirs; providers.mjs stays fabric-only. A reader trusting the comment will look for providers.mjs in rem/shared/ and not find it.

---

### [SR-20260825-017] [LOW] AGENTS.md — The Structure section omits two live modules — system-prompt/ (wired in setup.js lines 34/43) and scripts/shared/ — while documenting a dead .claude/workflows

- **Category:** Feature
- **Status:** FIXED (2026-08-25, by earlier subtask fork — system-prompt/ and scripts/shared/ bullets added; .claude/workflows bullet removed)
- **Confidence:** single-reviewer
- **Suggestion:** Add system-prompt/ and scripts/shared/ to the Structure bullet list and drop or correct the .claude/workflows bullet.

system-prompt/ is a first-class synced module (setup.js junctions it to both ~/.claude and ~/.codex) and is core to the fabric provider strategy, but AGENTS.md never mentions it. The architecture doc has drifted from the link table in setup.js.


## Review 2026-08-25 (follow-up)

## Review 2026-08-25 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer docs (docs review): OK

### Confirmed findings

---

### [SR-20260825-018] [HIGH] .claude/rules/rem/providers.md — Stale example in 'Secrets are machine-local' shows old env:<name> shape; new local file uses providers.<name>.apiKey

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Replace lines 12-15 example with the new shape: { "providers": { "deepseek": { "apiKey": "sk-..." }, "kimi": { "apiKey": "sk-..." } } }. This also makes the 'Shape mirrors the shared registry' claim on line 9 true again.

The new 'Provider schema' section declares the canonical shape as providers.<name> with an apiKey field. The new local template (claude_env_settings.local.template.json) already uses providers.<name>.apiKey, and the real user's claude_env_settings.json has been migrated. But the 'Secrets are machine-local' example at lines 12-15 still shows the legacy env:deepseek: { ANTHROPIC_API_KEY: 'sk-...' } shape. A user reading top-to-bottom sees a contradiction. The 'Shape mirrors the shared registry' claim on line 9 is now factually false. setup.js:298-315 still ships a migration nudge for this exact legacy shape, so the legacy shape is known to still exist on user machines.

---

### [SR-20260825-019] [MEDIUM] .claude/rules/rem/providers.md — Missing explicit migration callout for users whose local file still holds the old env:<provider> shape

- **Category:** Feature
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Add a 'Migrating from the legacy env:<provider> shape' subsection that shows the before/after and points to setup.js's one-time nudge.

setup.js:298-315 already detects the legacy env:<name> shape in the local file and prints a one-time migration pointer referencing providers.md — but providers.md doesn't actually document the migration. A user upgrading from before this refactor has no doc telling them the new per-provider shape or what the failure mode is if they don't migrate (ccds runs without an API key, cogmi with the wrong key — per setup.js:312-313).

---

### [SR-20260825-020] [MEDIUM] README.md — Provider Switching section omits the codex_config.toml model_providers.<id> precondition

- **Category:** Feature
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** In the 'Caveat for codex-side aliases' paragraph, add: 'You also need a [model_providers.<id>] block per provider in ~/.codex/codex_config.toml (env_key + wire_api = "responses"); see providers.md for the full precondition.'

providers.md:109-112 documents this precondition explicitly, but README.md — the top-level entry — does not. A user trying `cods` cold will hit 'model provider not found in config.toml' at codex startup, before they ever reach the network call. The README's end-to-end caveat only covers the chat/completions-vs-Responses failure, not the missing-toml-block failure.

---

### [SR-20260825-021] [LOW] .claude/rules/rem/providers.md — claudeExtras described as 'arbitrary key→value pairs' but only string values are forwarded

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Change to 'arbitrary string key→value pairs'; note that non-string entries (booleans/numbers) are silently dropped by cc-launcher.mjs:73.

cc-launcher.mjs:73 guards on `if (typeof v === 'string') env[k] = v;`. A user adding e.g. { 'SOME_FLAG': true } gets no error and no env var set.

---

### [SR-20260825-022] [LOW] .claude/rules/rem/providers.md — Out-of-scope 'co / cokm aliases' note is ambiguous about what each alias is for

- **Category:** Feature
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Clarify whether `co` is codex-default and `cokm` is Kimi, or just drop the note since the foundation is self-evident from the existing codex alias table.

Lines 131-133 don't make it clear whether `co` and `cokm` are both Kimi aliases (typo) or whether one is a separate provider. `co` reads naturally as 'codex default' (mirroring `ccc` = claude-default).


## Review 2026-08-25 (follow-up)

## Review 2026-08-25 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped

### Confirmed findings

---

### [SR-20260825-023] [HIGH] README.md — README's Hooks table omits the entire SessionStart chain, including the newly added setup-check-hook.js

- **Category:** Feature
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Add SessionStart rows for fix-lsp-windows.js, prune-cache-hook.js, setup-check-hook.js, and a short paragraph on what check-links.js auto-repairs vs. warns about, and that codex.js runs the same check.

claude_settings.json (and the template) register three SessionStart hooks: scripts/setup/fix-lsp-windows.js, scripts/hooks/prune-cache-hook.js, and scripts/hooks/setup-check-hook.js. The README table lists only Notification, Stop, and statusLine. The self-healing link check — the reason scripts/setup/check-links.js exists — is undocumented in the README.

---

### [SR-20260825-024] [HIGH] AGENTS.md — AGENTS.md documents `.claude/workflows/` as symlinked from the repo — the directory does not exist and setup.js never links it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the bullet, or add a real link entry plus the directory if the feature is wanted.

Structure claims `.claude/workflows/`: Saved workflow scripts (symlinked from repo). No such directory in the repo and no CLAUDE_LINKS entry.

---

### [SR-20260825-025] [HIGH] AGENTS.md — Workflows section claims notify-hook fires on TaskCompleted and PostToolUseFailure; only Notification is wired

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Reduce to Notification, and mention the SessionStart chain instead.

claude_settings.json and the template only contain SessionStart and Notification hook keys. Two of the three claimed events don't exist.

---

### [SR-20260825-026] [MEDIUM] README.md — README claims .claude/rules and .claude/memory are fully git-tracked via a `.claude/*` ignore pattern; .gitignore says otherwise and AGENTS.md contradicts it

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Fix the README paragraph: MEMORY.md and per-date _meta.json are device-local and gitignored; quote the actual `**/.claude/**` pattern.

Real .gitignore uses `**/.claude/**` and re-ignores `**/.claude/rules/MEMORY.md` and `**/_meta.json`. AGENTS.md correctly says MEMORY.md is device-local/gitignored. Two docs, two stories.

---

### [SR-20260825-027] [MEDIUM] README.md — Mojibake in README — encoding-corrupted characters plus a leading BOM

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Re-write those lines with real characters and the actual numbers from cc-market/rem/hooks/rem-hook.js, and strip the BOM.

UTF-8 `>=` mangled through a GBK round-trip in two lines (REM hook thresholds, ring-buffer size); README.md also starts with a UTF-8 BOM.

---

### [SR-20260825-028] [MEDIUM] AGENTS.md — `scripts/setup/` structure bullet lists only setup.js — five other scripts, including the new check-links.js, are undocumented

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Expand the bullet to enumerate the setup scripts, calling out check-links.js as the shared module.

The directory also contains check-links.js, install-shell-aliases.js, fix-lsp-windows.js, check-mac-notify.js, setup-vscode.js. check-links.js now has two independent consumers (setup-check-hook.js, codex.js).

---

### [SR-20260825-029] [MEDIUM] AGENTS.md — Structure list omits codex_config.toml / codex_config.template.toml even though setup.js copies and links them

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Add the codex_config.toml pair to the Structure list and note the user-maintained [model_providers.*] precondition.

setup.js copies codex_config.template.toml -> codex_config.toml and links it to ~/.codex/config.toml. AGENTS.md documents every other template pair but not this one, despite providers.md making its [model_providers.<id>] block a hard precondition for cods/cogmi.

---

### [SR-20260825-030] [MEDIUM] README.md — README never mentions `npm run setup`, `npm run migrate`, or `npm test` — only raw node invocations

- **Category:** Feature
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Add the npm script equivalents and an 'Upgrading an existing install' subsection pointing at npm run migrate / --dry-run.

package.json defines setup, replace_setup, setup_vscode, migrate, and test scripts. migrate appears nowhere in the README, so an upgrading user has no README-visible path to fixing stale links.

---

### [SR-20260825-031] [MEDIUM] README.md — Troubleshooting presents hard links purely as a Windows-privilege fallback; the claude-hud config is now an unconditional hard link on every platform

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Note in Troubleshooting: the claude-hud config is always hard-linked by design, requires same volume, and is the entry most likely to need periodic re-linking.

CLAUDE_LINKS marks claude_plugins/claude-hud/config.json with hardlink:true because claude-hud >= 0.8.0 rejects symlinked configs. README frames hard links only as the Windows EPERM fallback; EXDEV same-volume requirement is undocumented.

---

### [SR-20260825-032] [LOW] scripts/setup/setup.js — Legacy-shape migration notice names a nonexistent alias `cokm`

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Change to `ccds` / `cckm` / `cogmi`.

The nudge prints `ccds` / `cokm` / `cogmi`; the Kimi alias is `cckm` and cokm is not installed.

---

### [SR-20260825-033] [LOW] scripts/setup/setup.js — CLAUDE_LINKS links an `agents/` directory that does not exist — every run prints a SKIP

- **Category:** Bug
- **Status:** FIXED (2026-08-25, partial — link entry dropped from CLAUDE_LINKS; empty top-level `rules/` dir cleanup deferred pending explicit `rm -rf` confirmation)
- **Confidence:** single-reviewer
- **Suggestion:** Create and document agents/ or drop the link entry; remove the stray empty rules/ dir.

{ src: 'agents', ... } has no top-level agents/ dir; check-links.js has to special-case the skip string. There is also an empty top-level rules/ dir nothing links or documents.

---

### [SR-20260825-034] [LOW] README.md — README says the rem/sharp-review plugins are auto-registered without noting setup only does this on a fresh install

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Qualify: enabled via template on fresh install; existing installs use npm run migrate.

Plugin enablement ships in claude_settings.template.json, copied only when claude_settings.json is absent; existing installs get deltas via migrate.

---

### [SR-20260825-035] [LOW] README.md — Prerequisites link for Codex points at an unrelated repo

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Point the link at https://github.com/openai/codex.

Link text resolves to openai/codex-plugin-cc but the install command is @openai/codex (repo openai/codex).


## Review 2026-08-25 (follow-up)

## Review 2026-08-25 (session) — diff review + security audit (安全锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20260825-036] [HIGH] .claude/rules/rem/providers.md — The new "Migrating from the legacy env:<provider> shape" section is factually wrong about what setup.js does

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rewrite the section as: setup.js auto-migrates the local file in place (backup `claude_env_settings.local.json.setup-bak`); the only manual case is the `mixed` status where both shapes coexist and setup leaves the file untouched. Move the failure-mode list under that `mixed` case, which is the only one it actually applies to.

providers.md says: "`setup.js` detects the old shape and prints a one-line migration pointer on every run until you convert." That is not what the code does. `scripts/setup/setup.js:303` calls `migrateLocalEnvSettings({localPath})` from `scripts/setup/migrate-local-env-settings.mjs`, which **rewrites the local file in place** (with a `.setup-bak` backup) and prints `MIGR ... converted`. No pointer, no manual conversion, and it happens exactly once, not "on every run until you convert". The whole "**Failure modes if you skip the migration**" block (`ccds` runs without an API key, `cogmi` gets the wrong env var name) is therefore describing a scenario that cannot normally occur — the only case where a legacy file survives setup is the `mixed` status (both `env:` and `providers:` present), which the doc never mentions. Also 'Before/After' hand-conversion instructions are now busywork.

---

### [SR-20260825-037] [HIGH] scripts/runtime/cc-launcher.mjs — The claimed legacy `env:<provider>.<*ApiKeyEnv>` migration-aid fallback does not exist in either launcher

- **Category:** Bug
- **Status:** FIXED (2026-08-25 — fallback was removed at the user's explicit request; the gap is now closed by the launchers' missing-key error path in SR-038 rather than a silent fallback read)
- **Confidence:** single-reviewer
- **Suggestion:** Decide one way: either implement the fallback (`profile.apiKey ?? settings[`env:${provider}`]?.[profile.claudeApiKeyEnv]`) or drop the claim from the pass description. Do not document a compat layer that isn't in the code.

The stated intent of this pass includes "a new migration-aid fallback in cc-launcher.mjs/codex-launcher.mjs that reads `env:<provider>.<*ApiKeyEnv>` from the legacy local file shape when the new `providers.<name>.apiKey` is missing." Neither file contains any such code: `cc-launcher.mjs` only does `if (profile.claudeApiKeyEnv && profile.apiKey)`, and `codex-launcher.mjs` only `if (profile.codexApiKeyEnv && profile.apiKey)`. Nothing reads `env:*` at runtime — the only `env:` reader in the repo is the one-shot setup migrator. Either the fallback was never implemented, or the intent statement is stale. Since the fallback would only matter in the `mixed` case (setup declines to migrate), the gap is real: a mixed-shape local file leaves the launcher key-less at runtime with no compensation.

---

### [SR-20260825-038] [HIGH] scripts/runtime/cc-launcher.mjs — Missing API key silently launches the provider with no credentials — no error, contradicting providers.md

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Return `error: "Provider '<name>' has no apiKey — add it to ~/.claude/claude_env_settings.local.json under providers.<name>.apiKey"` when `claudeApiKeyEnv`/`codexApiKeyEnv` is declared but `apiKey` is absent. Add a test for it in the new *-launcher.test.mjs files (neither currently covers the missing-key case).

`buildClaudeInvocation` sets the key only when both `claudeApiKeyEnv` and `apiKey` are truthy, and otherwise returns `error: null`. `cc.js` then strips every ANTHROPIC_* var (PROVIDER_KEYS) and spawns `claude` with `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` set but no key, printing a cheerful `[cc] Using provider: deepseek`. The user gets an opaque 401 from a third-party endpoint instead of a config error. `codex-launcher.mjs` has the identical hole. providers.md still asserts "A machine without a local file fails with the existing 'missing ANTHROPIC_API_KEY' error — the intended failure mode" — that error no longer exists anywhere in the launcher path, so the doc is stale too.

---

### [SR-20260825-039] [MEDIUM] claude_env_settings.template.json — `codexApiKeyEnv` for kimi/gmi is set to Anthropic env-var names, contradicting the documented codex-side namespace

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Set `kimi.codexApiKeyEnv = "KIMI_API_KEY"` and `gmi.codexApiKeyEnv = "GMI_API_KEY"` (or whatever `env_key` the user's TOML blocks declare), and keep the two namespaces disjoint.

The template sets `kimi.codexApiKeyEnv = "ANTHROPIC_API_KEY"` and `gmi.codexApiKeyEnv = "ANTHROPIC_AUTH_TOKEN"`, while deepseek correctly uses `DEEPSEEK_API_KEY`. providers.md explicitly documents `codexApiKeyEnv` as "the literal env-var name configured via `model_providers.<id>.env_key` in `codex_config.toml`" — an OpenAI-side namespace that has nothing to do with ANTHROPIC_*. Worse, `codex-launcher.mjs` strips PROVIDER_KEYS (the ANTHROPIC_* list) *before* projecting, so for gmi the launcher deletes `ANTHROPIC_AUTH_TOKEN` and then re-sets it — surviving by accident of ordering, not by design. `cogmi` will hand codex a key under a name codex's `env_key` almost certainly doesn't reference.

---

### [SR-20260825-040] [MEDIUM] codex_config.template.toml — Shipped codex template has zero `[model_providers.*]` blocks, so `cods`/`cogmi` are dead on every fresh install

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Either ship commented-out `[model_providers.deepseek]` / `[model_providers.gmi]` blocks in the template, or have setup.js generate them from `providers.<name>` (the 'Out of scope' item in providers.md) — this is ~15 lines, not a follow-up PR.

README.md and providers.md both raise the missing-TOML-block precondition as a caveat the user must satisfy, but setup.js (`setup.js:274`) copies `codex_config.template.toml` verbatim on fresh install, and that template contains no `model_providers` section at all (grep returns nothing). So the aliases install successfully, print `cods - Codex + DeepSeek (single-source-of-truth: providers.deepseek)`, and then fail at first launch with "model provider not found". Documenting a known-broken default as a "precondition the user maintains" is a design cop-out when the info needed to generate the block (url, codexPath, codexApiKeyEnv) is already in `providers.<name>`.

---

### [SR-20260825-041] [MEDIUM] scripts/setup/migrate-local-env-settings.mjs — `mixed` status leaves the legacy file untouched forever with no actionable instruction and no runtime compensation

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Make the `mixed` message self-contained: name the specific `env:<x>` keys still present and the exact `providers.<x>.apiKey` targets to move them to. Add a `mixed` subsection to providers.md, or merge non-conflicting legacy blocks automatically and only bail on genuine per-provider conflicts.

When both `env:*` and non-empty `providers` exist, the migrator bails with `status: 'mixed'` and setup prints "left untouched — see .claude/rules/rem/providers.md". But providers.md's migration section (see the first finding) describes a completely different flow and never mentions `mixed`, so the pointer leads nowhere useful. This is also exactly the state produced by the perfectly normal sequence: setup copies the *new-shape template* into `~/.claude/` on a machine that... no wait — worse, a user who partially hand-edits their file lands here permanently. Combined with the silent-missing-key hole, a `mixed` file yields a launcher that silently runs unauthenticated.

---

### [SR-20260825-042] [LOW] scripts/runtime/codex.js — Full link-health scan runs synchronously on every `cods`/`cogmi` launch, before the binary spawns

- **Category:** Performance
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Throttle with a timestamp stamp (e.g. skip when a `~/.codex/.link-check` mtime is < 24h old), or run the check detached after the spawn so it never delays the TUI.

`codex.js` calls `checkLinks()` unconditionally at startup, which walks every entry in `CLAUDE_LINKS` + `getCodexLinks()` (the latter enumerates the skills dir), stat-ing each one — over OneDrive-backed paths on Windows, where a cold-cache stat can block for hundreds of ms. Claude Code's side runs the same work as an async SessionStart hook; the codex side puts it on the interactive critical path. The comment justifies *where* it runs but not *how often*.

---

### [SR-20260825-043] [LOW] README.md — README documents provider setup but never mentions the automatic local-file migration, while providers.md documents it (wrongly) — a third inconsistent account

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Add one line to README's upgrade section: "`npm run setup` auto-converts a legacy `env:<provider>` local secrets file to `providers.<name>.apiKey`, backing up the original to `claude_env_settings.local.json.setup-bak`." Then make providers.md match.

README's new 'Upgrading an existing install' section covers only `npm run migrate` (link/plugin migration) and says nothing about `claude_env_settings.local.json` being auto-rewritten in place by `npm run setup`. A user upgrading follows README, runs `npm run setup`, and has their secrets file silently rewritten with no forewarning that a `.setup-bak` is the recovery path. Across the three docs there are now three different stories: AGENTS.md (silent), README.md (silent), providers.md (says setup only prints a pointer). None matches the code.

---

### [SR-20260825-044] [LOW] scripts/shared/config.mjs — Stale comment still describes `env:<provider>` blocks as the merge target

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** s/env:<provider> blocks/providers.<name> blocks/.

The `deepMerge` doc comment reads "...so this is safe for env:<provider> blocks and the fabric block alike." That shape no longer exists on the read path — the merge now targets `providers.<name>`. Minor, but this file is explicitly cited by AGENTS.md as the shared-config source of truth, so a wrong comment here propagates.

---

### [SR-20260825-045] [LOW] scripts/setup/install-shell-aliases.js — codex aliases are written to `codexBin` but point at `codexJsPath` under `claudeDir`, which may not exist on a codex-only install

- **Category:** Bug
- **Status:** FIXED (2026-08-25)
- **Confidence:** single-reviewer
- **Suggestion:** Either resolve the codex launchers through `~/.codex/scripts/runtime/codex.js` (adding a link entry to `CODEX_LINKS`), or document explicitly that `~/.claude/scripts` is the shared script root for both hosts regardless of which binary is installed.

`codexJsPath` is built as `path.join(claudeDir, 'scripts', 'runtime', 'codex.js')`. On a Codex-only machine the `claudeBin` branch is skipped, but the `codexBin` branch still emits wrappers hard-coding a `~/.claude/scripts/runtime/codex.js` path. That link is created by setup's `CLAUDE_LINKS` processing so it usually exists — but the whole point of the `claudeBin`/`codexBin` split introduced here is that the two hosts are independent, and routing the codex launcher through `~/.claude` quietly reintroduces the coupling. Same for `aliases.sh`/`aliases.ps1`, which hardcode `~/.claude/scripts/runtime/codex.js`.
