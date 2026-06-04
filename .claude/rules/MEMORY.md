# Memory Index

<!--
Three-tier memory system:
  1. Rules (.claude/rules/)         — always injected, core behavioral constraints only
  2. Long-term memory (tier: long)  — progressive disclosure, demoted to short if inactive between prune cycles
  3. Short-term memory (tier: short) — progressive disclosure, 90d eviction

Promotion: run `node scripts/touch-memory.js <path> --promote` to upgrade short → long
Demotion:  long-term not accessed between two prune cycles → auto-demoted to short
Prune:     run `node scripts/prune-memory.js --evict-stale` (short-term eviction + long-term demotion check)
Compact:   run `node scripts/compact.js --check` when index grows large

Frontmatter:
  - created:  ISO date (parent folder date)
  - accessed: ISO date (bumped by touch-memory.js on reference)
  - tier:     long | short (default short, promoted via touch-memory.js --promote)
-->

## Tasks (progressive disclosure)

<!-- Task list managed by sync-tasks.js. Load on demand via the index entries below. Completed tasks are archived to memory/tasks/archive/ and evicted after 90d. -->

- [2026-06-04 Active Tasks](../memory/tasks/tasks.md) — 2 open

## Short-term (90d eviction window)

- [2026-06-04 takeover-model-bug](../memory/2026-06-04/takeover-model-bug.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-04 task-system](../memory/2026-06-04/task-system.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-03 memory mechanism — three-tier loading, timestamps, eviction](../memory/2026-06-03/memory-mechanism.md) — `created: 2026-06-03, accessed: 2026-06-03`
- [2026-06-03 takeover plugin v2 cleanup](../memory/2026-06-03/takeover-plugin-v2.md) — `created: 2026-06-03, accessed: 2026-06-03`
- [2026-06-03 update-plugins-hook-removed](../memory/2026-06-03/update-plugins-hook-removed.md) — `created: 2026-06-03, accessed: 2026-06-03`
- [2026-06-02 model effort strategy](../memory/2026-06-02/model_effort_strategy.md) — `created: 2026-06-02, accessed: 2026-06-02`
- [2026-05-31 sharp review hook provider config](../memory/2026-05-31/sharp_review_hook_provider_config.md) — `created: 2026-05-31, accessed: 2026-05-31`
- [2026-05-31 VS Code provider env vars](../memory/2026-05-31/vscode_provider_envvars.md) — `created: 2026-05-31, accessed: 2026-05-31`
- [2026-05-30 api-proxy KV cache removed](../memory/2026-05-30/api_proxy_kv_cache.md) — `created: 2026-05-30, accessed: 2026-05-30`
- [2026-05-30 api-proxy cache fix](../memory/2026-05-30/api_proxy_cache_fix.md) — `created: 2026-05-30, accessed: 2026-05-30`
- [2026-05-30 macos-notify-swift](../memory/2026-05-30/macos_notify_swift.md) — `created: 2026-05-30, accessed: 2026-05-30`
- [2026-05-30 macos-notify-sharp-review-findings](../memory/2026-05-30/notify_review_findings_unfixed.md) — `created: 2026-05-30, accessed: 2026-05-30`
- [2026-05-29 api-proxy auth fix](../memory/2026-05-29/api_proxy.md) — `created: 2026-05-29, accessed: 2026-05-29`
- [2026-05-29 ccgpt-removal](../memory/2026-05-29/ccgpt_removal.md) — `created: 2026-05-29, accessed: 2026-05-29`
- [2026-05-29 feedback-global-agents](../memory/2026-05-29/feedback_global_agents.md) — `created: 2026-05-29, accessed: 2026-05-29`
- [2026-05-28 VS Code provider wrapper broken](../memory/2026-05-28/vscode_provider_wrapper.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-28 takeover review fixes](../memory/2026-05-28/project_takeover_review.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-28 retrospect-hook-background-tasks](../memory/2026-05-28/retrospect_hook_background_tasks.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-28 retrospect-hook-task-guard](../memory/2026-05-28/retrospect_hook_task_guard.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-27 feedback_skills_location](../memory/2026-05-27/feedback_skills_location.md) — `created: 2026-05-27, accessed: 2026-05-27`
