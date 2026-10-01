---
name: feedback-targeted-tests-only
type: feedback
---

# Run only the tests that cover the change; the integrator runs everything

User instruction (2026-10-01): "integrator 会去负责跑全部测试，你仅仅简单跑相关测试".

**Rule:** as a dev agent (and when dispatching subagents), run only the test files that
cover what changed, plus lint on the changed files. Never start full suites, whole tiers
(`runner.py gate|heavy`, `pytest -q` over the whole tree, `npm test` across unrelated
areas), or `--collect-only` censuses unless the user asks.

**Why:** the family protocol already assigns the full re-gate to the coordinator/integrator
(lab-commons `the-three-participants.md`: the coordinator re-gates the combination). Full
runs by dev agents duplicate that work, hold the box/CPU lease other lanes need, and spawned
heavy children (femm) that had to be killed by hand.

**How to apply:** name the exact test paths in every subagent prompt and forbid full runs;
if a broad run is already going, stop it rather than wait on it.
