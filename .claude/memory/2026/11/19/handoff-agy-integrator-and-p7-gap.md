---
title: Handoff — Antigravity Alignment Landings & P7 Ad-hoc PR Mechanism Gap
created: 2026-11-19
accessed: 2026-11-19
tier: short-term
tags: [handoff, integrator, antigravity, dev-lab, p7, taskbinding]
---

# Handoff: Antigravity Family Alignment & P7 Ad-hoc PR Mechanism Fix

## Goal
Land the remaining Antigravity CLI (`agy`) family-alignment PRs across the 5 repos (`claude-code-config`, `cc-market`, `lab-commons`, `ai-lab`, `dev-lab`) and close the `dev-lab` P7 (`PUSHED-HEAD-CARRIES-ITS-TASK`) design gap where short ad-hoc fixes are forced through heavyweight long-lived `rem` task ceremonies (plus cross-repo ledger friction).

## Done So Far
1. **4 of 5 PRs pushed, opened `--ready`, and auto-merge enabled**:
   - `claude-code-config` (**PR #31**, `pr/agy-align` -> `integrate/main`, HEAD `1f2acee`): https://github.com/DawnEver/claude-code-config/pull/31
   - `cc-market` (**PR #48**, `pr/agy/antigravity-support` -> `main`, HEAD `33091f9`): https://github.com/DawnEver/cc-market/pull/48
   - `lab-commons` (**PR #217**, `pr/agy/home-exempt` -> `integrate/main`, HEAD `3250eca9`): https://github.com/DawnEver/lab-commons/pull/217
   - `ai-lab` (**PR #42**, `pr/agy/session-launcher` -> `integrate/main`, HEAD `3267d3f`): https://github.com/DawnEver/ai-lab/pull/42
2. **Prepared & verified `dev-lab` worktree (ready to push under a bound session)**:
   - Isolated worktree (DO NOT touch primary dirty checkout): `pr/agy/native-harness` @ `90b5fb1f` (2 commits atop `origin/integrate/main` `b309028c`: `50a1a50c` + `90b5fb1f`), 124 targeted tests + `ruff` + `filechecks` + `privatemarkers` all green.
3. **Cloudflare Dashboard Worker & Local Bridge Daemon**:
   - Deployed DO KV host-persistence fix (`https://dashboard.mingyangbao.site/`, version `5de2aa7d`) and restarted local bridge daemon onto `1f2acee` with live zero-token `agy -p /quota --output-format json` (`claude-gpt` + `gemini` quota pools).
4. **Closed `LAB_COMMONS_HOME` non-Claude host gap**:
   - Updated `cc-market/rem/scripts/session-binding.mjs` (`33091f9`) to fall back to `~/.claude/settings.json` `env.LAB_COMMONS_HOME` when Codex or Antigravity hooks run without Claude's settings `env` block injected.

## Left To Do (Ranked by Priority)
1. **Publish & land `dev-lab` worktree**:
   - In the integrator session (already bound to `toolchain`), rename `pr/agy/native-harness` -> `pr/toolchain/agy-native-harness`, push via `dev_lab.dev.netverb`, and open a `--ready` PR into `integrate/main` via `dev_lab.dev.forge pr create`.
2. **Fix the `dev-lab` P7 (`PUSHED-HEAD-CARRIES-ITS-TASK`) architectural defect for short/ad-hoc fixes**:
   - `src/dev_lab/dev/sessionbranch.py` (`_off_task`, `P7`) and `src/dev_lab/dev/branchset.py` (`FAMILY_TASK_HEADS = 'pr/<task>/<feature>'`) currently treat **every** `pr/*` push from an agent session (`session_of(env)` non-empty) as requiring a bound `rem` task (`pr/<task>/<feature>`), refusing flat `pr/<feature>` or `pr/fix/<feature>` when `session_task` is `None`.
   - Furthermore, `rem`'s `UserPromptSubmit` hook (`task-authority.js` -> `bindSession(cwd, ...)`) resolves the task ledger from the **current session's `cwd`** (`<main checkout>/.claude/tasks/`), so a session started in an agent repo (e.g. `cc-config`, which has no `.claude/tasks/`) cannot even bind to an existing family task (`toolchain`) that lives in the primary consumer repo's `.claude/tasks/`!
   - Design & implement an Occam's-razor, first-principles fix in `dev-lab` (and `rem` if needed):
     - **Option A (Recommended — Two-tier branch semantics: Task vs Ad-hoc)**: When a session IS bound to a task (`session_task(env)` is non-None), enforce `pr/<slug>/<feature>` so multi-PR campaign work stays grouped under its task; when a session is **unbound** (`session_task(env) is None`), admit short standalone PR branches (`pr/<feature>` or an explicit ad-hoc namespace like `pr/adhoc/<feature>` / `pr/fix/<feature>`) without forcing `/rem:task open` + `task: <slug>` ceremony! (Note: `head_refusals` on the forge server ALREADY passes `env={}` at `sessionbranch.py:405`, meaning the forge's `session-branch` status check already admits `pr/<feature>` — only the local `pre-push` hook was blocking unbound agent sessions!)
     - **Bonus cross-repo binding fix**: Allow `task: <repo>:<slug>` or fall back across `lab_commons.home.repos()` ledgers when `<cwd>/.claude/tasks/<slug>` is absent, so a cross-repo session started in `cc-config` or `dev-lab` can bind to `toolchain` directly if desired.
3. **Monitor & fast-forward local checkouts after auto-merge**:
   - Watch PRs #31 (`claude-code-config`), #48 (`cc-market`), #217 (`lab-commons`), #42 (`ai-lab`), and the new `dev-lab` PR until merged, and sync `cc-config/cc-market` onto `origin/main` once `cc-market` #48 lands.

## Next Step
From the `integrator` session (bound to `toolchain`), immediately rename and push the verified `dev-lab` branch (`pr/agy/native-harness` -> `pr/toolchain/agy-native-harness`) and open its PR into `integrate/main`, then implement the P7 unbound/ad-hoc fix in a follow-up `pr/toolchain/p7-adhoc-pr` worktree.

## Current State
- `claude-code-config`: on `pr/agy-align` (`1f2acee`), clean, PR #31 open with auto-merge. (Note: synced `~/.claude/claude_env_settings.json` has 1 minor doctor notice: missing top-level `"harness": {}` key relative to template.)
- `cc-market`: on `pr/agy/antigravity-support` (`33091f9`), clean, PR #48 open with auto-merge; `cc-config/cc-market` synced to `33091f9`.
- `lab-commons`: on `pr/agy/home-exempt` (`3250eca9`), clean tracked tree, PR #217 open with auto-merge.
- `ai-lab`: on `pr/agy/session-launcher` (`3267d3f`), clean tracked tree, PR #42 open with auto-merge (2 external Claude sessions hold primary `.venv/Scripts/python.exe`, do not delete primary `.venv`).
- `dev-lab`: primary checkout has user's uncommitted work (DO NOT TOUCH); isolated worktree `.claude/worktrees/agy-native-harness` is clean on `pr/agy/native-harness` (`90b5fb1f`) rebased onto `origin/integrate/main` (`b309028c`).

## Key Decisions
- **Trusted Host-Adapter Guard Bridge**: Kept `.claude/` as the sole per-repo guard/door declaration (`dev-lab/deny-commands.js` reverted to pure single-protocol); `cc-config/scripts/hooks/project-guard-bridge.mjs` projects both `agy` and `codex` events onto `.claude/settings*.json` gated by `~/.claude/trusted-origins`.
- **Option A for `session-bridge` on `agy`**: Removed `session-bridge` MCP from `~/.gemini/config/mcp_config.json`; wired `ANTIGRAVITY_CONVERSATION_ID` into `scripts/bridge/send-attachment.mjs`.
- **Zero-Token Antigravity Quota**: Combined `statusLine.telemetry: true` with background `agy -p /quota --output-format json` (`num_turns: 0`, `total_tokens: 0`).
- **Fabric `agy` Provider**: Added `agy` to `HOST_PROVIDERS` in `cc-market/fabric` (kept `ai-lab` strictly pay-per-token HTTP API per `ai_lab/retired.py`).

## Open Questions
- For the P7 short-fix design: should unbound agent sessions push flat `pr/<feature>` directly (matching `head_refusals` on the forge today), or push an explicit `pr/fix/<feature>` (or `pr/adhoc/<feature>`) prefix so unbound ad-hoc PRs remain visually distinct from bound `pr/<task>/<feature>` PRs?
