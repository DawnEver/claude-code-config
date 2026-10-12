---
name: sharp-review-2026-10-12
description: Sharp review findings — 5 total
metadata:
  type: project
---

## Review 2026-10-12 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261012-001] [HIGH] scripts/bridge/daemon.mjs — Guard drops every non-topic message, including private chats and non-forum groups, not just forum General

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use m.chat.is_forum && !m.is_topic_message, or ensure non-forum chats can never host sessions; test each chat type

is_topic_message is absent in DMs and plain groups.

---

### [SR-20261012-002] [HIGH] scripts/bridge/daemon.mjs — Early return may make chat-level commands typed in General unreachable

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Handle chat-level commands before the guard or scope the guard to session injection

Verify whether any session-independent command path exists downstream.

---

### [SR-20261012-003] [MEDIUM] scripts/bridge/daemon.mjs — Root cause remains: #sessionAt(chat, null) still matches Topic-less sessions for other callers

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Make #sessionAt never match a null threadId / null topicId

Fixing at the lookup covers callbacks and future callers.

---

### [SR-20261012-004] [MEDIUM] scripts/bridge/daemon.mjs — Dropped General messages are silent: no log, no user hint

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Debug-log the drop; optionally reply once pointing to Topics

Silent no-op is a known incident class in this repo.

---

### [SR-20261012-005] [MEDIUM] scripts/bridge/daemon.test.mjs — Test covers only the negative codex case; no positive topic routing, claude host, or is_forum distinction

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add positive-routing and per-host cases; set chat.is_forum in fixture

Suite stays green despite the DM regression.
