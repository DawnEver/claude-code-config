---
name: topic-title-and-banked-reset
description: Machine-first Topic titles with per-group projectInTitle; Claude banked-reset offers removed
---

# Topic title rule per group; Claude banked reset cut (2026-10-11)

## fe36f6d — Topic titles
- Order is now `machine | [project |] branch | agent[ · suffix]` (`topicTitle({...})`, daemon.mjs).
- `bridge.projects.<repo>.projectInTitle`: `always` (default) | `main` (project only on
  main/master) | `never`. Normalised in context.mjs. For a group dedicated to one repo.
- Suffixed (dedup) titles now go through `s.titleOf`, so they keep `claude:<seat>`; the old
  path dropped the seat. Existing Topics rename once (all titles changed format anyway).
- Payload: one project group set to `main`.

## c108361 — Claude banked reset removed
- Whether an account holds a reset to spend is account state. The old code offered the
  global clauderesets.com `reset_offers` to every seat minus a hand-kept `seats[].claimed`
  list: wrong source (Team seats may not get it), a drifting second copy, unofficial data.
- Anthropic `api/oauth/usage` (checked live) has no reset/credit field, so the report claims
  none for Claude. Codex keeps its account `rateLimitResetCredits`. Announced-but-not-applied
  resets still show for both hosts. `claimed` dropped from seats.mjs and the payload.

## Lesson
This repo is generic and public: build features as config knobs, never per-user special
cases; test fixtures use made-up names (doctor public-hygiene flagged a real project name).

## Residual
sharp-review reviewers all failed (fabric: deepseek model unresolved, claude.exe ENOENT,
codex review.mjs missing in fabric 0.2.20) — no review findings for these commits.
