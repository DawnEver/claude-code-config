---
name: sharp-review-2026-10-01
description: Sharp review findings — 17 total
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
- **Status:** FIXED
- **Fixed in:** 7c52098 (uncaughtExceptionMonitor observes without suppressing; bad runtime port is retried)
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
- **Status:** FIXED
- **Fixed in:** 7c52098 — duplicate of SR-20261001-001 (same finding re-appended by a follow-up review)
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
- **Status:** FIXED
- **Fixed in:** c6b3eda — closedAt cleared on re-attach; active holders are skipped; idle holders are invalidated
- **Confidence:** single-reviewer
- **Suggestion:** Skip cache entries whose key belongs to a live session, or clear closedAt in sessionUp when the cached Topic is picked up.

closedAt is only cleared when the lazy reopen runs on the first post; an idle reattached session's Topic is swept and s.topicId points to a deleted thread.

---

### [SR-20261001-004] [MEDIUM] scripts/bridge/daemon.mjs — The sweep is not serialized with per-session close/reopen, so a stale cacheSet can write a deleted Topic back into the cache

- **Category:** Bug
- **Status:** FIXED
- **Fixed in:** c6b3eda — delete runs in the holder queue and re-checks the cache entry after the await
- **Confidence:** single-reviewer
- **Suggestion:** Run deletes through #serial(s) or re-check topicCache[k] === v after the await.

deleteForumTopic is awaited outside the serial queue.

---

### [SR-20261001-005] [LOW] scripts/bridge/daemon.mjs — deleteWarned never resets, so later failures of other kinds are never logged

- **Category:** Bug
- **Status:** FIXED
- **Fixed in:** c6b3eda — each distinct error logged once; reset after a success
- **Confidence:** single-reviewer
- **Suggestion:** Log again when the error message changes, or reset after a successful delete.

Network errors and 429s are hidden and wrongly blamed on the missing rights.

---

### [SR-20261001-006] [LOW] scripts/bridge/daemon.mjs — The hourly sweep logs even when nothing was deleted or the feature is disabled; the ?? 24 default is duplicated

- **Category:** Performance
- **Status:** FIXED
- **Fixed in:** c6b3eda — only deletions are logged; default lives in context.mjs; no sweep scheduled when 0
- **Confidence:** single-reviewer
- **Suggestion:** Log only when n > 0, and skip scheduling when hours is 0.

---

### [SR-20261001-007] [INFO] scripts/bridge/daemon.mjs — daemon.mjs is 469 lines; extract the topic-cache logic into its own module

- **Category:** Feature
- **Status:** FIXED
- **Fixed in:** c6b3eda — topic cache extracted to scripts/bridge/topic-cache.mjs with its own tests
- **Confidence:** single-reviewer
- **Suggestion:** Move #cachedTopic, #cacheSet and the sweep into their own module.

---

### [SR-20261001-008] [HIGH] scripts/bridge/daemon.mjs — The sweep permanently deletes the Topic of a live reattached session (closedAt is kept until the first post)

- **Category:** Bug
- **Status:** FIXED
- **Fixed in:** c6b3eda — same fix as SR-20261001-003 (duplicate root cause)
- **Confidence:** single-reviewer
- **Suggestion:** Serialize deletion against reattach/reopen, re-check eligibility right before deleting, and invalidate any affected session mapping.

Reproduced with sessionUp() followed by sweepClosedTopics(). The Object.entries snapshot also lets a reopen during an earlier delete go unseen.


## Review 2026-10-01 (follow-up)

## Review 2026-10-01 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261001-009] [HIGH] scripts/bridge/daemon.mjs — The sweep can delete the Topic of a session that is live again, leaving it posting into a deleted thread

- **Category:** Bug
- **Status:** FIXED — duplicate of SR-20261001-003 (re-appended by a stale post-review run); fixed in c6b3eda
- **Confidence:** single-reviewer
- **Suggestion:** Skip cache entries whose key belongs to a live session, or clear closedAt in sessionUp when the cached Topic is picked up.

closedAt is only cleared when the lazy reopen runs on the first post; an idle reattached session's Topic is swept and s.topicId points to a deleted thread.

---

### [SR-20261001-010] [MEDIUM] scripts/bridge/daemon.mjs — The sweep is not serialized with per-session close/reopen, so a stale cacheSet can write a deleted Topic back into the cache

- **Category:** Bug
- **Status:** FIXED — duplicate of SR-20261001-004 (re-appended by a stale post-review run); fixed in c6b3eda
- **Confidence:** single-reviewer
- **Suggestion:** Run deletes through #serial(s) or re-check topicCache[k] === v after the await.

deleteForumTopic is awaited outside the serial queue.

---

### [SR-20261001-011] [LOW] scripts/bridge/daemon.mjs — deleteWarned never resets, so later failures of other kinds are never logged

- **Category:** Bug
- **Status:** FIXED — duplicate of SR-20261001-005 (re-appended by a stale post-review run); fixed in c6b3eda
- **Confidence:** single-reviewer
- **Suggestion:** Log again when the error message changes, or reset after a successful delete.

Network errors and 429s are hidden and wrongly blamed on the missing rights.

---

### [SR-20261001-012] [LOW] scripts/bridge/daemon.mjs — The hourly sweep logs even when nothing was deleted or the feature is disabled; the ?? 24 default is duplicated

- **Category:** Performance
- **Status:** FIXED — duplicate of SR-20261001-006 (re-appended by a stale post-review run); fixed in c6b3eda
- **Confidence:** single-reviewer
- **Suggestion:** Log only when n > 0, and skip scheduling when hours is 0.

---

### [SR-20261001-013] [INFO] scripts/bridge/daemon.mjs — daemon.mjs is 469 lines; extract the topic-cache logic into its own module

- **Category:** Feature
- **Status:** FIXED — duplicate of SR-20261001-007 (re-appended by a stale post-review run); fixed in c6b3eda
- **Confidence:** single-reviewer
- **Suggestion:** Move #cachedTopic, #cacheSet and the sweep into their own module.

---

### [SR-20261001-014] [HIGH] scripts/bridge/daemon.mjs — The sweep permanently deletes the Topic of a live reattached session (closedAt is kept until the first post)

- **Category:** Bug
- **Status:** FIXED — duplicate of SR-20261001-008 (re-appended by a stale post-review run); fixed in c6b3eda
- **Confidence:** single-reviewer
- **Suggestion:** Serialize deletion against reattach/reopen, re-check eligibility right before deleting, and invalidate any affected session mapping.

Reproduced with sessionUp() followed by sweepClosedTopics(). The Object.entries snapshot also lets a reopen during an earlier delete go unseen.


## Review 2026-10-01 (follow-up)

## Review 2026-10-01 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20261001-015] [LOW] claude_plugins/session-bridge/server.mjs — Diagnostic log reintroduces CLAUDE_PID right after routing moved off it; may invite reliance again

- **Category:** Bug
- **Status:** NO_CHANGE — superseded: CLAUDE_PID is now a deliberate nested-session signal (6f53986), so logging it is the diagnostic
- **Confidence:** single-reviewer
- **Suggestion:** Label as legacy/diagnostic-only or drop once session-id migration confirmed

ppid is often a shell/node wrapper on Windows, so mismatch with CLAUDE_PID is expected and may mislead.

---

### [SR-20261001-016] [LOW] claude_plugins/session-bridge/server.mjs — Fallback session id derivation inputs not logged; collisions undiagnosable

- **Category:** Feature
- **Status:** FIXED
- **Fixed in:** bbd2b43 — `sessionIdentity` logs where the id came from, fallback inputs (hostname, pid, random) included
- **Confidence:** single-reviewer
- **Suggestion:** Log the raw inputs of the fallback id when used

Two sessions resolving to the same fallback id is the real failure mode post-change.

---

### [SR-20261001-017] [INFO] claude_plugins/session-bridge/server.mjs — cwd and PIDs logged in plain text

- **Category:** Bug
- **Status:** FIXED
- **Fixed in:** bbd2b43 — kept, and docs/bridge.md states the runtime logs are machine-local, contain paths and pids, and are never mirrored or synced
- **Confidence:** single-reviewer
- **Suggestion:** Keep log machine-local; never mirror to Telegram or sync payload

cwd contains username.
