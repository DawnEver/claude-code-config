---
name: sharp-review-2026-10-02
description: Sharp review findings — 1 total
metadata:
  type: project
---


## Review 2026-10-02 (session) — diff + adversarial review (internal fallback)

### Reviewer Status
- Reviewer internal-diff (internal diff reviewer): OK
- Reviewer internal-adversarial (internal adversarial reviewer): OK

### Confirmed findings


## Review 2026-10-02 (follow-up)

## Review 2026-10-02 (session) — security audit (安全锐评) + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261002-001] [MEDIUM] scripts/setup/install-cli-wrappers.js — Unchanged managed wrappers that lost their execute bit are no longer repaired; setup reports them as up to date

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Check the mode independently of content (fs.statSync), chmod only when the exec bits are missing, and report an actionable error on EPERM instead of reporting success

Reproduced: install wrappers, chmod ccc 0644, rerun install -> stays non-executable. Before this change, rerunning setup repaired it.
