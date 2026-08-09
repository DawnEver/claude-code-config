---
name: system-prompt-platform
description: Self-maintained system prompt platform — GLOBAL-AGENTS.md owns principles, claude-base.md/codex-base.md platform layers, toolsPreset tiers, style system, official radar; measured cache mechanics
created: 2026-08-09
tags: [system-prompt, cache, styles, codex, fabric, cost]
---

# System-prompt platform (2026-08-09, built in this repo)

One prompt stack for every non-native path (fabric providers incl. codex);
native `claude` keeps the official prompt. Full docs: `system-prompt/README.md`
+ `cc-lab/reports/system-prompt-platform.md` (research) +
`cc-lab/reports/system-prompt-audit.md` (140 official parts classified).

## Files (this repo)
- `GLOBAL-AGENTS.md` (~500 tok, symlinks: `~/.claude/CLAUDE.md` +
  `~/.codex/AGENTS.md`): ALL universal principles + prefs (first principles,
  delivery scope, analysis, safety, correction, language, code style, LSP, TDD,
  communication, git, rem memory + todos).
- `system-prompt/claude-base.md` (~330 tok): claude platform — tool-preset
  discipline (removed tools named absent), delegation, PushNotification.
- `system-prompt/codex-base.md` (~300 tok): codex platform — shell/apply_patch,
  single-execution, approval waits. Wired via codex_config.toml (gitignored)
  `model_instructions_file` (FORWARD slashes required).
- Tooling: discover-styles.mjs (official lookup + STYLE_SEARCH_DIRS),
  build.mjs (base+style→dist, static validation), sync-official.mjs (Piebald
  radar → CHANGELOG absorption list, human-only), validate-cache.mjs
  (two-run usage check; claude-base healthy: 15,600 read / 0 create).
  Tests in discover-build.test.mjs (npm test = 34 pass).

## Verified mechanics (tap, vanilla api.anthropic.com, haiku 4.5)
- Injection ~42.3k = tools schema 33.6k (80%) + system 4.3k + CLAUDE.md 4.3k.
- `--system-prompt "<static>"` = cache key: first process create ~6.4k, next
  reads 25,752 / creates 0; different prompt → 19,373+6,379.
- output-style does NOT inject under --system-prompt (styles live in our files).
- codex model_instructions_file replaces built-in base; AGENTS.md appends
  (3-layer verified: instructions + AGENTS symlink + project docs).
- Official `--exclude-dynamic-system-prompt-sections` (flag-only; settings
  field IGNORED — native TUI keeps official prompt as-is).
- codex has NO cross-process cache (tokens used constant across runs).

## fabric wiring (cc-market/fabric)
- `fabric.systemPromptFile` default; profile.systemPromptFile > profile.style
  (auto-built dist) > default. Both spawn paths. --tools/--system-prompt-file
  are profile-owned. toolsPreset: exec 6.1k / coord 7.7k / daily 16.4k /
  full 33.6k tok (schema trimming, NOT permissions; --allowedTools separate).

## User constraints
- Native claude = official prompt. Every non-native path defaults to custom
  prompt. Styles switchable (coding/academic/post + extensible). Background/
  subagent/team sections user-reviewing — untouched. Iteration memory lives in
  cc-market/fabric; research in cc-lab.
