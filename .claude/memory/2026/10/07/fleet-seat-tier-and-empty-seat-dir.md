---
name: fleet-seat-tier-and-empty-seat-dir
description: Fleet report false "no subscription login" for empty seat dirs fixed; Claude seat tier shown; fabric model/exe drift broke sharp-review
---
# Fleet: empty seat dir and seat tier (2026-10-07, cc-config a4131f9)

- False alarm: on one host a seat's login lives in the base `~/.claude`, while
  `~/.claude-<alias>` exists but never logged in. `claudeGroups` (fleet.mjs) flagged that
  empty alias dir "no subscription login". Fix: `held(seat)` — an alias dir with no account
  raises no problem when another local dir holds its seat. Regression in fleet.test.mjs.
- Tier: `.claude.json` `oauthAccount.seatTier` (`team_labs_premium` / `team_labs_standard`)
  is read by `readAccount` (seats.mjs, field `tier`) and rendered after the org through
  `PLAN_NAMES` -> "Team Premium" / "Team Standard". Codex already showed `planType`.
- A "wrong team" warning on the other seat was real (dir logged into the other team's org);
  re-login fixed it. Org matching is a case-insensitive substring of organizationName.
- "data Nh old" in a posted report = a daemon running pre-bffcaac code.

# sharp-review reviewers failing: fabric drift (cc-market 63d0ec8)

Both failures were fabric, not config: fabric read `claudeModel`/`claudeExtras` while
provider blocks use `models` (now projected by `modelEnv()`, same as cc-launcher), and
resolveClaudeExe only knew the npm-prefix claude.exe while the host had a native install at
`~/.local/bin/claude.exe`. Takes effect after a cc-market release + plugin auto-update (the
installed cache copy runs, not the dev clone).
