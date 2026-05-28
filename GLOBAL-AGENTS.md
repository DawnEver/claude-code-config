# Global Preferences

## Language
- Output code and file contents in English unless explicitly asked otherwise.
- Conversation can be in any language the user prefers.

## Code Style
- Write clean, minimal, elegant code with unnecessary comments.
- Prefer editing existing files over creating new ones.

## Workflow
- Use LSP if available.
- Aggressively use subagents for high-token-cost operations or when multiple tasks to do.

## Git Hygiene
- Commit messages: imperative, conventional (`feat:`, `fix:`, `docs:` …), passing messages directly with `-m "..."` using double quotes.
- Never force-push shared branches; use `--force-with-lease` if unavoidable.

## Memory
- Always manage memory with the project's `.claude/memory`; never use auto memory stored in the user directory.
- Update the index of the memory in @.claude/rules/MEMORY.md
