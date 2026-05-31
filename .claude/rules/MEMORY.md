# Memory Index

<!-- Sorted by date, newest first. Keep at most 20 entries. -->

- [2026-05-30 api-proxy cache fix — anthropic-beta stripped + cache_control removed](../memory/2026-05-30/api_proxy_cache_fix.md) — SAFE_REQ_HEADERS missing anthropic-beta + stripCacheControl() killed prompt caching; both fixed; cache: 3k confirmed in HUD
- [2026-05-30 api-proxy auth fix — ANTHROPIC_AUTH_TOKEN bearer→x-api-key](../memory/2026-05-29/api_proxy.md) — Use ANTHROPIC_AUTH_TOKEN (not API_KEY) for DeepSeek; proxy converts bearer token to x-api-key header
- [2026-05-30 api-proxy KV cache removed — claude-hud has native token breakdown](../memory/2026-05-30/api_proxy_kv_cache.md) — Removed metrics tracking, SSE interceptor, /metrics endpoint, kv-cache-status.js; hud-hook simplified
- [2026-05-30 macOS notify fix — terminal-notifier replaced with Swift binary](../memory/2026-05-30/macos_notify_swift.md) — macOS 26.5 breaks terminal-notifier & AppleScript; NSUserNotificationCenter works from CLI
- [2026-05-30 Notify sharp review findings (unfixed)](../memory/2026-05-30/notify_review_findings_unfixed.md) — 13 issues found by parallel Codex+DeepSeek review; HIGH: silent failure, dead -open code, compileNotifyBinary error count
- [2026-05-29 ccgpt removed — Codex uses agent-identity JWT](../memory/2026-05-29/ccgpt_removal.md) — ChatGPT bridge deleted; Codex token incompatible with any standard API endpoint
- [2026-05-29 GLOBAL-AGENTS.md is global — never edit](../memory/2026-05-29/feedback_global_agents.md) — Only AGENTS.md is project-specific; GLOBAL-AGENTS.md is symlinked to ~/.claude/CLAUDE.md
- [2026-05-29 api-proxy known bugs](../memory/2026-05-29/api_proxy.md) — Local proxy for DeepSeek only; ChatGPT bridge removed; some sharp-review bugs unfixed
- [2026-05-31 VS Code provider wrapper BROKEN](../memory/2026-05-28/vscode_provider_wrapper.md) — claudeCode.claudeProcessWrapper rejects shell scripts; Claude Code validates native binary; leave unset
- [2026-05-28 Retrospect hook task guard convention](../memory/2026-05-28/retrospect_hook_task_guard.md) — Set taskActiveUntil in .retro_state.json at start of sequential multi-round skills; auto-expires 30min
- [2026-05-28 Retrospect hook background_tasks fix](../memory/2026-05-28/retrospect_hook_background_tasks.md) — Guard against mid-task interruption using input.background_tasks; session_id leak also fixed
- [2026-05-28 Takeover review fixes](../memory/2026-05-28/project_takeover_review.md) — Architectural invariants after 3-round sharp review: stdin-only prompt delivery, testable callers in lib.mjs, unified Agent dispatch, early --write rejection, retry logic
- [2026-05-27 Git commit: use Bash](../memory/2026-05-27/feedback_git_commit.md) — Always use Bash (not PowerShell) for git commit; PowerShell here-strings leak @ into messages
- [2026-05-27 Skills location](../memory/2026-05-27/feedback_skills_location.md) — All skills/agents go in repo `skills/<name>/SKILL.md`, symlinked to `~/.claude/skills`
