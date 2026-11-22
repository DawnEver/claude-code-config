---
name: handoff-dashboard-fixes-and-branch-cleanup
description: "2026-11-22 handoff: Accounts windows 5h-first and the Usage tab names its fault (deployed 7eef9c0); every unlanded branch of this repo and cc-market merged up to date and pushed, PRs listed; WS1 Telegram inbound is undeclared"
metadata:
  type: project
---

State at 2026-11-22 23:05 UTC (dated context, not a rule).

User asked (translated): fix the Telegram dashboard -- (1) on Accounts, Antigravity lists 7d before 5h while Claude Code lists 5h first; 5h must come first; (2) the Usage page is blank again; (3) clean every branch of the migrated config repos: merge what is unlanded, then clean.

Done and live:
- (1) PR #48 (merged, promoted to main 7eef9c0, dashboard deployed by hand 21:58 UTC, live version 7eef9c0). Cause: scripts/bridge/quota.mjs windowModels kept the order a source sampled its windows in, and Antigravity reports the weekly bucket first. Now sorted by windowMs. The order is computed by the local bridge daemon, so it shows only after the daemon runs the new code: the checkout was fast-forwarded and the daemon replaced (`node scripts/bridge/ensure.mjs --replace`, pid 31240 at 23:01 UTC).
- (2) NOT reproduced. Ruled out: deployed files equal the repo; the D1 store answers and holds rows to the current hour; the live 1/7/30/90/365-day reports render without a fault in the smoke DOM, with filters, demo mode and two other time zones. Real defect fixed in the same PR: a view that threw was only logged to the console and its tab stayed empty, and the Usage tab was redrawn unguarded when its report arrived. Each view now writes "This view could not be drawn: <why>" into its own box; app-smoke.test.mjs gained a non-example-mode run (example mode never draws a report) and a planted broken report. Next step: if the user still sees a blank Usage tab, ask for that line or a screenshot, and whether the 24h/7d/30d range bar shows (no bar = a different failure, before renderUsage).
- Note: dashboard-deploy.yml did not run on the promote push; it was dispatched by hand (`gh workflow run dashboard-deploy.yml --ref main`). Worth checking why the push trigger did not fire.

Branch cleanup (3) -- every branch merged with its landing branch by merge (never rebase), clean, pushed; landing is by each PR's CI:
- claude-code-config -> integrate/main: #36 pr/codex-turn-hooks, #49 pr/agy-family-deny (contains #36; adds the family deny rows and a guard fix "the family guard runs under cc-config's own interpreter" written by the cleanup agent -- review it), #35 pr/toolchain/automode-channel-user, #34 pr/memory-declared-channel-python, #33 pr/toolchain/branch-limits (uv.lock conflict resolved), #50 pr/family-single-source (from 11-01), #51 pr/the-sync-payload-is-never-hard-linked (from 11-08, doctor.js conflict resolved).
- cc-market -> main: #52 pr/reviewer-scholarone-import (the nine never-pushed local commits of feat/reviewer-scholarone-import, merged with main and ruff-formatted; the local branch itself was left untouched), #50, #49, #45, #38, #37 and the existing PR of pr/toolchain/task-close-prunes-its-branches.
- NOT verified per branch: both cleanup agents stopped on the model usage limit before handing back, so whether #33, #50 and #51 are already superseded on integrate/main was never checked, and the cleanup agent's last note was one flaky sync-hook test file in the hard-link worktree to rerun alone. Read each PR's CI before landing; close a superseded one rather than merging it.
- origin/vscode-extension (2026-05-10, 610 behind, archives the extensions main already deleted): not merged; judged baggage, left for the user to delete.
- Old checkout D:/Documents/MingyangBao/cc-config: its 7 local branches were all landed and its worktrees held nothing unlanded; worktrees removed through `python -m dev_lab.dev.worktrees --remove`. The checkout itself stays until the user says (ruling 2026-11-22).
- Still to clean after landing: the worktrees under claude-code-config/.claude/worktrees and cc-market/.claude/worktrees, then the landed branches.

Open, needs the user:
- WS1 accepts no inbound Telegram message: the daemon logs "bridge allowlist empty ... nothing declared" since at least 2026-11-20, because hosts-config hosts/WS1.toml has no `[dev] channels = { "session-bridge" = "<id>" }` (G and WS5 declare the user's numeric id by the user's approval). Declaring it gives Telegram messages the user's authority on WS1, so it waits for an explicit yes.
