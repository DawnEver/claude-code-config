---
name: Doctor understands optional Claude model selection
description: Preserve the CLI-written preference while detecting actual payload shape drift.
metadata:
  type: implementation
---

# Outcome

The model warning was a false template-drift classification of Claude's legitimate
optional /model preference. Doctor now excludes only the top-level model field in
claude_settings.json from template key-presence comparison, while rejecting an invalid
non-string/empty value. Other payload filenames and real missing/extra keys are still
checked. No shared payload, provider catalogue or user model preference was changed.

Official precedence confirms --model and ANTHROPIC_MODEL override settings model;
provider projections therefore remain the model catalogue authority. A template-wide
fixed model was deliberately not added, avoiding a new forced preference or a missing
key warning when the CLI clears selection.

TDD regression covers present/absent valid model, invalid value, unrelated extra key
and missing required key. Focused doctor suite passes and live doctor is now clean.
Source: https://code.claude.com/docs/en/model-config#setting-your-model
