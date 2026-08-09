# Self-maintained system-prompt platform

One prompt stack for every non-native path (fabric providers incl. codex), with
switchable styles; native `claude` keeps the official prompt.

**Why:** measured on claude 2.1.226, a spawned `claude -p` injects ~42.3k tokens
= tools schema 33.6k (80%) + system text 4.3k + CLAUDE.md 4.3k. A byte-stable
`--system-prompt-file` head + trimmed `--tools` schema makes every process a
cross-process cache hit (verified: run 2 = full cache_read, ~0 create). Full
research + audit: `cc-lab/reports/system-prompt-platform.md` and
`cc-lab/reports/system-prompt-audit.md` (140 official parts classified
clean/keep).

## File layout

| file | role | injection |
|------|------|-----------|
| `../GLOBAL-AGENTS.md` | ALL universal principles + preferences (first principles, safety, language, TDD, git, rem memory) | every path via `~/.claude/CLAUDE.md` AND `~/.codex/AGENTS.md` (both symlinks) |
| `claude-base.md` | claude platform specifics: tool-preset discipline (removed tools named absent), delegation (subagents/fork/SendMessage), PushNotification | `--system-prompt-file` on fabric spawns |
| `codex-base.md` | codex platform: shell/apply_patch discipline, single-execution, approval waits | `model_instructions_file` in `~/.codex/config.toml` (gitignored) |
| `dist/<style>.claude.md` | built prompt = claude-base + style body | via `profile.style` (auto-built when stale) |
| `discover-styles.mjs` | style discovery — official lookup (user → project cwd→root, nearest wins) + `STYLE_SEARCH_DIRS` extra dirs; reads frontmatter, never moves config | — |
| `build.mjs` | claude-base + style body → dist; static validation (no cwd/env/gitStatus/time leaks) | — |
| `sync-official.mjs` | official-update radar: diffs Piebald extraction → absorption list in CHANGELOG.md (human only) | — |
| `validate-cache.mjs` | two-run usage comparison → cross-process cache health | — |
| `CHANGELOG.md` | absorption log + SOP | — |

## Injection wiring (fabric)

`claude_env_settings.json` → `fabric.systemPromptFile` = platform default;
`fabric.profiles.*` may override:

```json
{ "fabric": {
    "systemPromptFile": "C:/.../system-prompt/claude-base.md",
    "profiles": {
      "writer":   { "style": "academic" },
      "executor": { "toolsPreset": "exec", "systemPromptFile": "C:/.../academic.claude.md" },
      "planner":  { "toolsPreset": "coord", "allowedTools": "Read,Glob,Grep,SendMessage" }
    }
}}
```

Priority: `profile.systemPromptFile` > `profile.style` (auto-built) >
`fabric.systemPromptFile`. Both spawn paths (persistent `openSession`,
stateless `spawnChild`) honor it; `--system-prompt-file`/`--tools` are
profile-owned (extraArgs cannot override). codex ignores profiles (app-server
has no tool/permission surface) — it uses `model_instructions_file` + AGENTS.md.

## Tool presets (`toolsPreset` → `--tools`, schema trimming, NOT permissions)

| preset | tools | schema |
|--------|-------|--------|
| exec | Bash, Read, Write, Edit, Glob, Grep | ~6.1k tok |
| coord | Read, Glob, Grep, Bash, SendMessage, PushNotification, WebFetch, WebSearch | ~7.7k tok |
| daily | exec + Skill, Agent, Worktree×2, Monitor, ScheduleWakeup, WebFetch, WebSearch, SendMessage, PushNotification | ~16.4k tok |
| full | (no `--tools`) all 31 | ~33.6k tok |

`--tools` trims the injected schema; `--allowedTools` is the permission control
(keep them aligned: a coord agent with only `--tools` still gets asked before
every action — set `allowedTools` to the same list when the role should act
unprompted). MCP tools (fabric's 15) auto-attach and are unaffected.

## Styles

Dropping `name.md` with frontmatter into any discovered output-styles dir adds a
style (`~/.claude/output-styles/`, project `.claude/output-styles/`, or
`STYLE_SEARCH_DIRS`). `profile.style: "academic"` picks it; build happens
automatically when missing/stale. `keep-coding-instructions: false` = the style
body carries the persona (post/academic); `true` layers on top.

## codex notes

- `model_instructions_file` path MUST use forward slashes (backslashes silently
  ignored via `-c`).
- Three layers verified: instructions (system) → `~/.codex/AGENTS.md` (global,
  symlink to GLOBAL-AGENTS.md) → project AGENTS/CLAUDE.md (fallback).
- codex has NO cross-process prompt cache (tokens used constant across
  identical runs) — the injection is a correctness lever, not a cost lever.
- No tool presets on codex: the tool set is fixed (shell/apply_patch/web_search).

## Instruction layering (all providers, systematic)

One model, three layers — enforced by code, not convention:

| layer | content | channel |
|-------|---------|---------|
| system (persistent) | GLOBAL principles (via CLAUDE.md/AGENTS.md symlinks) + platform base (claude-base/codex-base) + style | `--system-prompt-file` / `model_instructions_file` / `body.system` (API providers read `fabric.systemPromptFile` — added 2026-08-10) |
| per-call (user message) | mode template (`prompts/*.md` — mode-specific ONLY; the overlap guard test forbids restating GLOBAL phrases) + explicit `customSystem` + user prompt | mcp-server prepends the mode template to the user prompt on every provider |
| project | CLAUDE.md / AGENTS.md | auto-injection |

`prompts/task.md` was de-duplicated against GLOBAL (2026-08-10): universal
principles live in exactly one place. The guard test
(`fabric/tests/prompts-overlap.test.mjs`) fails any future edit that reintroduces
dual-source instructions.

## Official-update tracking

Full replacement keeps runtime immune to official prompt updates. Run
`sync-official.mjs` against a Piebald clone to get the human absorption list;
follow the SOP in CHANGELOG.md. Known limitation: native-claude TUI cache
optimization (`--exclude-dynamic-system-prompt-sections`) is CLI-flag only —
the settings field is ignored, so the TUI keeps the official prompt as-is.
