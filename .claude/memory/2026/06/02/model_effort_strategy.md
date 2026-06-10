---
name: model-effort-strategy
description: Model and effort level strategy — opusplan for auto plan/exec split, sharp-review hook delegates to sharp-review skill
metadata:
  type: project
created: 2026-06-02
accessed: 2026-06-10
tier: long
access_count: 2
---

# Model & Effort Strategy

**Decision:** Use `opusplan` model + low effort as default. Sharp-review hook delegates to `/sharp-review` skill instead of running its own review analysis.

**Why:** User wants three-tier strategy:
1. Daily dev → Sonnet + low (cost efficient)
2. Plan mode → Opus + high (best reasoning)
3. Auto review → Sonnet + high (thorough analysis)

`opusplan` auto-switches Opus during plan mode and Sonnet during execution — solves #1 and #2 model split. Plan mode effort remains session-level (low), but Opus + low is already strong; manually `/effort high` for critical plans.

For #3: `sharp-review-hook.js` now injects `/sharp-review` via exit code 2, delegating to the sharp-review skill (`skills/sharp-review/SKILL.md`) which runs 3 parallel reviewers (Codex + takeover deepseek + takeover claude) with cross-check. The hook only handles classification (none/once/triple) and state tracking; all review logic lives in the skill. Hook timeout back to 30s since it only classifies (15s).

**How to apply:** New sessions use `opusplan` automatically. No manual model switching needed. For critical plan sessions, run `/effort high` before `/plan`.
