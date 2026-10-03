---
name: sharp-review-2026-10-03
description: Sharp review findings — 19 total
metadata:
  type: project
---


## Review 2026-10-03 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261003-001] [MEDIUM] scripts/bridge/daemon.mjs — Moving machine to the end hides the field that tells two hosts' Topics apart

- **Category:** Bug
- **Status:** WONTFIX (topicTitle already bounds length while keeping " | <machine> | <agent>" — covered by the Topic-fields test)
- **Confidence:** single-reviewer
- **Suggestion:** Cap the branch at a fixed width (e.g. 40) so machine and agent stay visible.

Project prefix is constant within a per-project group; long branches push machine/agent past the visible part of truncated titles on mobile.

---

### [SR-20261003-002] [MEDIUM] scripts/bridge/daemon.mjs — Old-format titles are only migrated for sessions that reconnect; dormant and closed Topics keep the old order forever

- **Category:** Bug
- **Status:** WONTFIX (documented in docs/bridge.md Topics: historical inactive Topics are not bulk rewritten; closed ones are deleted after deleteClosedAfterHours)
- **Confidence:** single-reviewer
- **Suggestion:** Add a one-time rename pass at startup, or document the behavior in docs/bridge.md.

Rename happens only in the session-up path, so a forum ends up with titles in both formats.

---

### [SR-20261003-003] [LOW] scripts/bridge/daemon.mjs — A failed rename puts the legacy title back with a single warning; the retry path has no test

- **Category:** Bug
- **Status:** FIXED (rename-failure test added)
- **Confidence:** single-reviewer
- **Suggestion:** Add a test for a rename that throws; log every failed rename.

Failures after the first are warned only once (warnOnce), and old titles go into the uniqueness set.


## Review 2026-10-03 (follow-up)

## Review 2026-10-03 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261003-004] [HIGH] scripts/bridge/fleet.mjs — Fleet card is dead code: renderCard/claudeQuota/codexQuota/seatFor are not imported by daemon or any runtime; docs/bridge.md lacks the cited Fleet card section

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Wire into daemon (with alert dedupe, Codex limits) and document, or don't ship yet

Only live part is hud-hook writing claude-usage.json on every statusLine render, which nothing reads.

---

### [SR-20261003-005] [HIGH] scripts/hooks/hud-hook.js — Statusline now hard-depends on fleet.mjs via static import and replays stdin by redefining process.stdin

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Dynamic import in try/catch; pass payload directly; add hud-hook replay test

A broken fleet.mjs kills the HUD; defineProperty(process,'stdin') fails if claude-hud reads fd 0 directly.

---

### [SR-20261003-006] [MEDIUM] scripts/bridge/fleet.mjs — Alerts ignore snapshot age; stale Claude snapshots still raise running-short and projections

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Suppress projections/alerts when now - q.at exceeds a few minutes

windowView treats used-at-snapshot as current at now.

---

### [SR-20261003-007] [MEDIUM] scripts/bridge/fleet.mjs — codexQuota labels windows only <=24h vs 'wk'; two short windows collide

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Label by actual duration or primary/secondary

Silently drops or mislabels windows.

---

### [SR-20261003-008] [MEDIUM] scripts/bridge/fleet.mjs — Wrong-seat check skipped when account is null; org-only mismatch mislabeled 'another account'

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Alert on missing oauthAccount for registered seat; distinct messages for email vs org mismatch

API-key login or unreadable ~/.claude.json reports as correct seat; empty seat.org matches anything.

---

### [SR-20261003-009] [MEDIUM] scripts/bridge/fleet.mjs — 'unregistered' alert fires on every host without fleet.json

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Alert only when a registry exists and this machine is absent

Contradicts setup comment; reintroduces the noise 9f72b15 removed.

---

### [SR-20261003-010] [LOW] scripts/bridge/fleet.mjs — Past reset rendered as 0% used

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Show stale/reset instead

Fabricated observation.

---

### [SR-20261003-011] [LOW] scripts/bridge/fleet.mjs — teeClaudeUsage reads/parses per render; crashed writes leave .tmp files

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Clean up tmp on catch

Minor.

---

### [SR-20261003-012] [LOW] scripts/bridge/fleet.test.mjs — Tests cover happy paths only

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add hud replay, stale snapshot, null account, missing registry, DST, same-length codex windows

6 tests.

---

### [SR-20261003-013] [INFO] docs/sync-architecture.md — fleet.json registered as payload but no doctor check

- **Category:** Feature
- **Status:** WONTFIX (optional by design; the card itself reports "no fleet.json")
- **Confidence:** single-reviewer
- **Suggestion:** Add doctor WARN like private-markers or state it's intentional

---

### [SR-20261003-014] [HIGH] scripts/setup/setup.js — Private fleet.json registry is not gitignored

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add fleet.json to .gitignore

With no sync dir it resolves to repo root; contains emails/org names in a public repo.

---

### [SR-20261003-015] [MEDIUM] scripts/bridge/fleet.mjs — Stale observations produce drifting burn rates and fabricated resets

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Compute rate at snapshot time; mark window unknown after reset; suppress stale alerts

Alert can clear without new data.

---

### [SR-20261003-016] [MEDIUM] scripts/bridge/fleet.mjs — Org substring matching accepts wrong organization

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Match by email + organizationUuid

'Team A' matches 'Team AB'; whitespace matches all.

---

### [SR-20261003-017] [MEDIUM] scripts/bridge/fleet.mjs — Quota snapshots carry no account identity and survive account switches

- **Category:** Bug
- **Status:** FIXED (stale snapshots never alert; the account is re-read every tick)
- **Confidence:** single-reviewer
- **Suggestion:** Bind snapshot to account/org; invalidate on change

Previous seat's quota shown under new seat.

---

### [SR-20261003-018] [MEDIUM] scripts/bridge/fleet.mjs — Exhausted quota hidden by early-window guard

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Handle used >= 100 before elapsed threshold

Untested branch.

---

### [SR-20261003-019] [MEDIUM] scripts/bridge/fleet.mjs — Malformed registry crashes fleet calculation

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Validate registry shape and unique machine assignment on load

{seats:{}} throws; readJson swallows all errors.
