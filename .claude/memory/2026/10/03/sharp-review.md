---
name: sharp-review-2026-10-03
description: Sharp review findings — 33 total
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


## Review 2026-10-03 (follow-up)

## Review 2026-10-03 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): OK

### Confirmed findings

---

### [SR-20261003-020] [MEDIUM] scripts/hooks/hud-hook.js — The stdin tee guards the import but not the global process.stdin mutation, leaving a latent crash path in a load-bearing hook

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Wrap the Object.defineProperty(process, 'stdin', ...) and buffering loop in the same try/catch, or pass the raw string to the plugin directly.

defineProperty runs outside the fail-open try; a non-configurable stdin would break the status line. for await also blocks until stdin closes.

---

### [SR-20261003-021] [LOW] scripts/bridge/fleet.mjs — The real account email is embedded in the alert key and persisted to fleet-card.json

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Use a non-PII key such as seat:wrong-account or a hash.

flag(`seat:${account.email}`) stores the email in state.alerts, written every tick.

---

### [SR-20261003-022] [LOW] scripts/bridge/fleet.mjs — FleetCard.#save() rewrites the state file every 60s tick even when nothing changed

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Save only when text or alerts change.

tick() always calls #save().

---

### [SR-20261003-023] [LOW] scripts/bridge/daemon.mjs — fleetSessions lists a session whose host disconnected under Running as 'Ended'

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Exclude Ended/disconnected sessions from the busy list.

renderCard treats any status !== 'Idle' as busy; disconnected maps to Ended.

---

### [SR-20261003-024] [LOW] scripts/bridge/codex-adapter.mjs — Quota push overwrites the whole snapshot and read path lacks the limitId === 'codex' filter

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Merge pushed windows and apply the same filter on read.

A primary-only push drops secondary until next read; read and push can disagree on the bucket.

---

### [SR-20261003-025] [INFO] docs/bridge.md — Fleet-card docs say idle sessions show as a count, but code neither counts nor lists them

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update the docs row to match renderCard.

Doc drift vs 51025f0 behavior.

---

### [SR-20261003-026] [MEDIUM] scripts/bridge/fleet.mjs — Alerts re-fire whenever their condition lapses for one tick, including when the snapshot goes stale

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Retain sent alert keys until the window resets; add hysteresis to the short check.

Stale ticks drop short:* keys from state.alerts, so the next fresh snapshot re-sends the same alert.

---

### [SR-20261003-027] [MEDIUM] scripts/bridge/fleet.mjs — resetsAt in the short-alert key causes duplicate alerts when reset time jitters

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Round resetsAt to a window boundary before building the key.

Key short:${host}:${k}:${v.resetsAt} changes with any reported jitter.

---

### [SR-20261003-028] [MEDIUM] scripts/bridge/fleet.mjs — Saved messageId is reused after fleet chatId/topicId change, so the bot can edit an unrelated message

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Persist chatId/topicId with the state and clear messageId on mismatch.

Message ids are per chat; editMessageText(newChat, oldId) may hit another bot message.

---

### [SR-20261003-029] [MEDIUM] scripts/bridge/daemon.mjs — Fleet ticks on setInterval have no overlap guard; partial alert-send failure resends already sent alerts

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Keep one in-flight tick promise; record each alert key right after its send succeeds.

Slow/429 ticks can overlap and both send cards/alerts.

---

### [SR-20261003-030] [LOW] scripts/bridge/fleet.mjs — Usage and account paths ignore CLAUDE_CONFIG_DIR while hud-hook honours it

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Resolve both paths from CLAUDE_CONFIG_DIR like hud-hook.

Custom config dir produces false seat alerts or wrong quota.

---

### [SR-20261003-031] [LOW] scripts/bridge/fleet.mjs — Account email written in plain text to fleet-card.json via alert key, without private file permissions

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Hash the key and use writePrivateFile.

flag('seat:'+account.email) persists the email.

---

### [SR-20261003-032] [LOW] scripts/bridge/codex-adapter.mjs — Codex quota timestamped at read time and read path lacks limitId filter, so a stuck feed never looks stale

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Apply the limitId filter on read; clear quota on disconnect.

quota.at = now() on every read/push.

---

### [SR-20261003-033] [LOW] scripts/bridge/fleet.test.mjs — No tests for tick overlap, alert re-fire after stale gap, chat/topic change, or partial alert-send failure

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add FleetCard tests with a fake clock.

Only pure render logic is covered.


## Review 2026-10-03 (follow-up)

## Review 2026-10-03 (session) — security audit (安全锐评) + diff review

### Reviewer Status
- Reviewer claude (claude): FAILED
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped
- Warning: only 1/2 reviewers succeeded

### Confirmed findings
