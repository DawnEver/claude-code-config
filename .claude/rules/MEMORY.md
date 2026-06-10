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

## Scoped

- REM plugin → see cc-market/rem/.claude/rules/MEMORY.md
- Sharp-review plugin → see cc-market/sharp-review/.claude/rules/MEMORY.md
- Takeover plugin → see cc-market/takeover/.claude/rules/MEMORY.md
- cc-market (cross-plugin) → see cc-market/.claude/rules/MEMORY.md
- Watch plugin → see cc-market/watch/.claude/rules/MEMORY.md

## Entries (tier per-file frontmatter — see comment above)










- [2026-06-10 sharp-review-2026-06-10](../memory/2026/06/10/sharp-review.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-10 migrate-tooling](../memory/2026/06/10/migrate-tooling.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-09 task-lib-split](../memory/2026/06/09/task-lib-split.md) — `created: 2026-06-09, accessed: 2026-06-09`
- [2026-06-09 sharp-review-2026-06-09](../memory/2026/06/09/sharp-review.md) — `created: 2026-06-09, accessed: 2026-06-08`
- [2026-06-08 sharp-review-2026-06-08](../memory/2026/06/08/sharp-review.md) — `created: 2026-06-08, accessed: 2026-06-08`
- [2026-06-07 cc-market-separate-repo](../memory/2026/06/07/cc-market-separate-repo.md) — `created: 2026-06-07, accessed: 2026-06-07`
- [2026-06-06 feedback-no-auto-push](../memory/2026/06/06/feedback-no-auto-push.md) — `created: 2026-06-06, accessed: 2026-06-06`
- [2026-06-04 git-tidy-skill-update](../memory/2026/06/04/git-tidy-skill-update.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-04 sharp-review-2026-06-04](../memory/2026/06/04/sharp-review.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-04 task-system](../memory/2026/06/04/task-system.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-06-03 memory-mechanism](../memory/2026/06/03/memory-mechanism.md) — `created: 2026-06-03, accessed: 2026-06-03`
- [2026-06-03 update-plugins-hook-removed](../memory/2026/06/03/update-plugins-hook-removed.md) — `created: 2026-06-03, accessed: 2026-06-03`
- [2026-06-02 model-effort-strategy](../memory/2026/06/02/model_effort_strategy.md) — `created: 2026-06-02, accessed: 2026-06-02`
- [2026-05-31 vscode-provider-envvars](../memory/2026/05/31/vscode_provider_envvars.md) — `created: 2026-05-31, accessed: 2026-05-31`
- [2026-05-29 ccgpt-removal](../memory/2026/05/29/ccgpt_removal.md) — `created: 2026-05-29, accessed: 2026-05-29`
- [2026-05-29 api-proxy](../memory/2026/05/29/api_proxy.md) — `created: 2026-05-29, accessed: 2026-06-10`
- [2026-05-30 macos-notify-swift](../memory/2026/05/30/macos_notify_swift.md) — `created: 2026-05-30, accessed: 2026-06-10`
- [2026-05-28 retrospect-hook-background-tasks](../memory/2026/05/28/retrospect_hook_background_tasks.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-28 retrospect-hook-task-guard](../memory/2026/05/28/retrospect_hook_task_guard.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-28 vscode-provider-wrapper](../memory/2026/05/28/vscode_provider_wrapper.md) — `created: 2026-05-28, accessed: 2026-05-28`
- [2026-05-27 git-commit-use-bash](../memory/2026/05/27/feedback_git_commit.md) — `created: 2026-05-27, accessed: 2026-05-27`
- [2026-05-27 feedback_skills_location](../memory/2026/05/27/feedback_skills_location.md) — `created: 2026-05-27, accessed: 2026-05-27`
