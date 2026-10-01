---
name: sharp-review-2026-10-01
description: Sharp review findings — 8 total
metadata:
  type: project
---



## Review 2026-10-01 (session) — diff review + security audit (安全锐评)

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261001-001] [MEDIUM] claude_plugins/session-bridge/server.mjs — uncaughtException handler suppresses fail-fast, leaving channel permanently disconnected

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use process.on('uncaughtExceptionMonitor') to observe without suppressing termination, or log then process.exit(1).

If runtime.json holds an invalid port, net.connect() throws synchronously before any retry timer exists. The new handler logs and swallows it, so the process stays alive on stdin with no daemon link and no recovery; MCP requests keep succeeding while Telegram delivery is silently dead.


## Review 2026-10-01 (follow-up)

## Review 2026-10-01 (session) — diff review + security audit (安全锐评)

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261001-002] [MEDIUM] claude_plugins/session-bridge/server.mjs — uncaughtException handler suppresses fail-fast, leaving channel permanently disconnected

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use process.on('uncaughtExceptionMonitor') to observe without suppressing termination, or log then process.exit(1).

If runtime.json holds an invalid port, net.connect() throws synchronously before any retry timer exists. The new handler logs and swallows it, so the process stays alive on stdin with no daemon link and no recovery; MCP requests keep succeeding while Telegram delivery is silently dead.


## Review 2026-10-01 (follow-up)

## Review 2026-10-01 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261001-003] [HIGH] scripts/bridge/daemon.mjs — The sweep can delete the Topic of a session that is live again, leaving it posting into a deleted thread

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Skip cache entries whose key belongs to a live session, or clear closedAt in sessionUp when the cached Topic is picked up.

closedAt is only cleared when the lazy reopen runs on the first post; an idle reattached session's Topic is swept and s.topicId points to a deleted thread.

---

### [SR-20261001-004] [MEDIUM] scripts/bridge/daemon.mjs — The sweep is not serialized with per-session close/reopen, so a stale cacheSet can write a deleted Topic back into the cache

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Run deletes through #serial(s) or re-check topicCache[k] === v after the await.

deleteForumTopic is awaited outside the serial queue.

---

### [SR-20261001-005] [LOW] scripts/bridge/daemon.mjs — deleteWarned never resets, so later failures of other kinds are never logged

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Log again when the error message changes, or reset after a successful delete.

Network errors and 429s are hidden and wrongly blamed on the missing rights.

---

### [SR-20261001-006] [LOW] scripts/bridge/daemon.mjs — The hourly sweep logs even when nothing was deleted or the feature is disabled; the ?? 24 default is duplicated

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Log only when n > 0, and skip scheduling when hours is 0.

---

### [SR-20261001-007] [INFO] scripts/bridge/daemon.mjs — daemon.mjs is 469 lines; extract the topic-cache logic into its own module

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move #cachedTopic, #cacheSet and the sweep into their own module.

---

### [SR-20261001-008] [HIGH] scripts/bridge/daemon.mjs — The sweep permanently deletes the Topic of a live reattached session (closedAt is kept until the first post)

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Serialize deletion against reattach/reopen, re-check eligibility right before deleting, and invalidate any affected session mapping.

Reproduced with sessionUp() followed by sweepClosedTopics(). The Object.entries snapshot also lets a reopen during an earlier delete go unseen.
