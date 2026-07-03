---
name: sharp-review-2026-07-03
description: Sharp review findings — 2 total
metadata:
  type: project
---

## Review 2026-07-03 (session) — diff review

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): skipped
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260703-001] [INFO] claude_settings.template.json — Template-only change: existing gitignored claude_settings.json copies are not updated by setup (template is copied only when the file is missing), so this key won't reach already-set-up machines without manual edit or a migrate step

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Either mirror the key into local claude_settings.json on each machine or add it to the settings-migration logic in setup.js/migrate if it should apply everywhere

---

### [SR-20260703-002] [LOW] claude_settings.template.json — showTurnDuration only reaches new clones — setup.js copies the template solely when claude_settings.json is absent, and unlike enabledPlugins.takeover there is no key-level migration, so existing installs never receive it

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** If the key should apply on this and other existing machines, add it via the settings-merge block in setup.js (like the takeover migration) or set it manually in each local claude_settings.json; otherwise accept template-only drift
