# Global Preferences

- Code and files in English; conversation in the user's language.
- Clean, minimal, elegant code — cross-platform, team-aware. Prefer editing
  existing files over creating new ones.
- Use LSP when available. Delegate to subagents for large multi-part work.
- TDD: failing test → simplest pass → refactor.
- Git: imperative conventional commits; tests before commit/push; never
  force-push shared branches; retry 3× before reporting blocked. On Windows
  Bash use heredocs, not PowerShell here-strings, for multi-line messages.
- Memory: project `.claude/memory` via `/rem`; no user-dir auto memory.
  TODOs via `rem:todo`.
