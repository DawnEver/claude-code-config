---
name: sharp-review-2026-06-04
description: Sharp review findings — 4 total
metadata:
  type: project
---

## Review 2026-06-04 (session) — current branch

### Reviewer Status
- Reviewer A (Codex, via takeover): OK
- Reviewer B (Claude): OK
- Reviewer C (Claude): OK

### Confirmed findings

---

### [SR-20260604-001] [MEDIUM] claude_settings.template.json — Removing top-level "model": "opusplan" contradicts documented default model strategy

- **Category:** Bug
- **Module:** settings template
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either keep "model": "opusplan" or update model-strategy.md to reflect the new default; otherwise new clones won't get the documented default model

rules/rem/model-strategy.md states 'Default: opusplan model + low effort.' Removing this key from the template means fresh setups silently diverge from documented behavior — undocumented config drift.

---

### [SR-20260604-002] [LOW] claude_settings.template.json — Removed codex plugin entry without any explanatory note (commit message/comment) on why it's dropped

- **Category:** Feature
- **Module:** settings template
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a brief note in AGENTS.md or commit message clarifying codex plugin removal rationale (deprecated? superseded by takeover?) so future readers aren't confused

The diff silently drops both enabledPlugins entry and the openai-codex marketplace source block. Given AGENTS.md documents provider-switching architecture in detail, an undocumented removal of an entire plugin/source is a maintainability smell.

---

### [SR-20260604-003] [MEDIUM] claude_settings.template.json — Removes top-level "model": "opusplan" default without updating documented model strategy

- **Category:** Bug
- **Module:** settings template
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update .claude/rules/rem/model-strategy.md (which states 'Default: opusplan model') to match, or restore the setting

The rules file model-strategy.md says 'Default: opusplan model + low effort' — removing the template's model default makes the documented default inaccurate/stale unless intentionally superseded elsewhere (e.g. per-user config). No comment or memory note explains why it was dropped.

---

### [SR-20260604-004] [LOW] claude_settings.template.json — Removes codex plugin entry and its enabledPlugins flag together — fine, but no corresponding doc/memory update referenced in diff

- **Category:** Feature
- **Module:** settings template
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a short memory note (per AGENTS.md conventions) documenting why codex@openai-codex was dropped, mirroring the existing 'ccgpt-removal' precedent

AGENTS.md/MEMORY.md shows precedent for recording plugin removals (e.g. ccgpt-removal, update-plugins-hook-removed). This removal has no accompanying memory entry in the diff, breaking that convention and making future audits harder.
