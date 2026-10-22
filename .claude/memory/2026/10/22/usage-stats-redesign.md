---
name: usage-stats-redesign
description: Audit of usage/time/resource stats and the proposed rebuild (transcripts as SoT, external SQL DB for humans + AI)
---
# Usage stats redesign (proposal, not implemented)

## Current state (2026-10-22)
- Quota: `scripts/bridge/quota.mjs` + `quota-series.mjs` — % per 5h/7d window from statusLine
  `rate_limits` (Claude, teed by hud-hook) and Codex `account/rateLimits`; series dropped when
  the window resets. No tokens/cost, no per-session attribution, Claude only fresh while a session renders.
- Time: none beyond dashboard status + time since last change.
- Resources: `resources.mjs` instantaneous CPU/mem/NVIDIA GPU, no history.
- traceme (archived) scanned Claude transcripts into SQLite; its claim that Codex is
  SQLite-only is WRONG — `~/.codex/sessions/**/rollout-*.jsonl` carries `token_count` events.

## Proposal
- Sole source: host transcripts (Claude `~/.claude*/projects/**/*.jsonl`, Codex rollouts).
  Cost = tokens x price (price in ai-lab provider catalogue), project = git root of cwd,
  task = lane (branch/worktree), time = turn timestamps. No new instrumentation.
- L0 sources -> L1 scanner `scripts/usage/` (two host adapters, turn-level facts, idempotent
  upsert, local cursor file only) -> L2 external DB (facts + rollup views + schema doc table
  for AI) -> L3 Mini App Usage view / AI read-only SQL / CLI.
- Metadata only in the DB (public repo); no prompt/answer text — AI goes back to the transcript by session id.
- Delete traceme entirely once ported; drop fabric NDJSON ingest (double counting).
- Recommended DB: hosted Postgres (Neon) for a read-only AI role; D1 alternative (no new service, no roles).
- Needs `cleanupPeriodDays` raised (default 30d deletes transcripts) + backfill at launch.

## Open decisions (awaiting user)
Postgres vs D1; cleanupPeriodDays value.
