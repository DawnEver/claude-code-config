---
name: sharp-review-2026-10-23
description: Sharp review findings — 2 total
metadata:
  type: project
---


## Review 2026-10-23 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer diff (openai): unavailable
- Reviewer adversarial (openrouter): unavailable
- Warning: only 0/2 reviewers succeeded

### Confirmed findings


## Review 2026-10-23 (follow-up)

## Review 2026-10-23 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer diff (codex): ok
- Reviewer adversarial (deepseek): unavailable
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261023-001] [MEDIUM] claude_settings.template.json — Async UserPromptSubmit mirror can land after a channel reply or the Stop mirror; the stamp guard covers only activity, so the stale prompt still clears s.sent and changes s.remoteTurn, and a reply sent before it is re-sent by Stop

- **Category:** Bug
- **Status:** FIXED (UserPromptSubmit bridge back to sync)
- **Confidence:** single-reviewer
- **Reviewers:** diff (codex)
- **Suggestion:** Serialize prompt initialization with later turn events or make its side effects turn-aware (gate on the at stamp) instead of applying stale prompts unconditionally

---

### [SR-20261023-002] [MEDIUM] scripts/bridge/claude-adapter.mjs — Sync AskUserQuestion #question sets waiting-input without advancing stateAt, so a delayed async PostToolUse from the previous tool passes the guard and flips the session back to running while the question is unanswered (up to 10 min)

- **Category:** Bug
- **Status:** FIXED (daemon state writes stamp stateAt)
- **Confidence:** single-reviewer
- **Reviewers:** diff (codex)
- **Suggestion:** Stamp question requests and advance stateAt on their transitions; add a test delivering an older activity after a question
