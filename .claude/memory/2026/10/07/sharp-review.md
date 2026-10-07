---
name: sharp-review-2026-10-07
description: Sharp review findings — 12 total
metadata:
  type: project
---


## Review 2026-10-07 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261007-001] [HIGH] scripts/bridge/fleet.mjs — Removing the data age hides a dead quota feed: stale numbers render indefinitely and passed resets show 'renewed' with no observation

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a (!) warning or age line past a larger threshold (e.g. 6h); render a passed reset with no newer snapshot as 'renewed (no data since)'/unknown; test multi-day staleness.

A 15-minute-old and a 6-day-old snapshot look identical; after resetsAt all windows read 'renewed' and the headline title is empty, so a dead producer is invisible.

---

### [SR-20261007-002] [MEDIUM] scripts/bridge/fleet.mjs — 'exhausted' from a stale snapshot ignores unscheduled extra resets / spent reset credits tracked elsewhere in the bridge

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Only claim exhausted from a fresh snapshot, or cross-check extra-resets/credits; stale 100% could read '≥100%' / 'was exhausted'.

extra-resets.mjs exists because out-of-band resets happen; the new 32h-old test locks the wrong claim in.

---

### [SR-20261007-003] [LOW] scripts/bridge/fleet.mjs — Headline still picks the binding window via stale ETA projection

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** When stale, skip the short/eta ranking; pick exhausted then highest used.

Inconsistent with 'never projected from'.

---

### [SR-20261007-004] [LOW] scripts/bridge/fleet.mjs — stale/bound declared after headline; mark parameter is needless indirection

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move stale above headline; replace bound with a boolean helper.

Works only because calls happen after module init.


## Review 2026-10-07 (follow-up)

## Review 2026-10-07 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): OK

### Confirmed findings

---

### [SR-20261007-005] [HIGH] scripts/hooks/bridge-hook.js — flushSpool discards queued Telegram deliveries returned by the adapter during spool replay

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Preserve deliveries until a live Stop hook can emit deliverOutput, or replay via an endpoint that does not consume the inbound queue.

bridge-hook.js:169 - replaying a spooled final for a session without inbound channel support returns queued messages in `deliver` and clears the adapter queue; flushSpool ignores the response, so the instructions are lost. Reproduced.

---

### [SR-20261007-006] [HIGH] scripts/hooks/bridge-hook.js — Spool is deleted before replay sends complete; the 2.5s hook exit timer can kill replay and lose in-flight and remaining entries

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Keep a recoverable claimed file, acknowledge entries individually, and bound replay so the current event is sent or durably spooled before exit.

bridge-hook.js:164-169 - each send may take 2s; with multiple entries and an unresponsive daemon the process exits mid-replay. Reproduced with three entries: only the first survived.

---

### [SR-20261007-007] [HIGH] scripts/hooks/bridge-hook.js — AskUserQuestion answers mirrored to Telegram without isSecret filtering

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Skip or redact answers for questions marked isSecret before emitting the answer mirror.

answerText (bridge-hook.js:66-70) serializes tool_response.answers verbatim; adapter emits an 'answered locally' notice posted to Telegram. Claude path hardcodes isSecret:false (claude-adapter.mjs:211).

---

### [SR-20261007-008] [MEDIUM] scripts/hooks/bridge-hook.js — Machine-wide shared spool file can replay stale finals out of order after dedupe state reset; no size bound

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Scope the spool per session and cap entries/size.

SPOOL_FILE is one path for all sessions/seats; a stale final replayed after a newer prompt reset s.sent passes dedupe and re-posts. Only a 1h TTL bounds it.

---

### [SR-20261007-009] [MEDIUM] scripts/bridge/codex-adapter.mjs — Including all commentary in Codex finals yields unbounded noisy Telegram messages

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Cap or summarize commentary, or make it configurable.

finalText (codex-adapter.mjs:92-99) joins every agentMessage including commentary; long turns produce large walls and hit Telegram's 4096-char limit.

---

### [SR-20261007-010] [LOW] scripts/hooks/bridge-hook.js — finalAssistantText is a dead shim used only by tests

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete it and have tests call turnTexts(...).join directly.

bridge-hook.js:63 has no production callers.

---

### [SR-20261007-011] [LOW] scripts/bridge/claude-adapter.mjs — localQuestion is a single boolean: reset on re-register, unset for timed-out remote questions answered locally, wrong with multiple questions

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Track per-ref question provenance.

Set in #question only when !(p.wait && s.remoteTurn) (line 219), reset in register (line 101).

---

### [SR-20261007-012] [LOW] scripts/bridge/claude-adapter.mjs — All activity notices with text are sent with alert:true, including benign waiting-input

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Alert only for waiting-approval.

#mirror (claude-adapter.mjs:247) hardcodes alert:true.
