# Global Preferences

## Language
- Output code and file contents in English unless explicitly asked otherwise.
- Conversation can be in any language the user prefers.

## Code Style
- Write clean, minimal, elegant code with necessary comments.
- Prefer editing existing files over creating new ones.

## Workflow
- Use LSP if available.
- Aggressively use subagents for high-token-cost operations or when multiple tasks to do.
- Consider cross-platform compatibility and team collaboration during design, implementation, and documentation.
- Practice test-driven development (TDD): write a failing test first, make it pass with the simplest change, then refactor. Add or update tests alongside any behavioral change.

## Git Hygiene
- Commit messages: imperative, conventional (`feat:`, `fix:` …), double-quoted `-m`. 
Via the Bash tool, never use PowerShell `@'...'@` here-strings (they leak `@`); use a Bash HEREDOC for multi-line messages.
- Never force-push shared branches; use `--force-with-lease` if unavoidable.
- Always run tests before `commit` and `push`; never commit or push with failing or unrun tests.
## Memory
- Always manage memory with the project's `.claude/memory`; never use auto memory stored in the user directory.
- Full conventions (format, scripts, eviction) are in the `/rem` skill — loaded only when needed.
- Manage TODO tasks via the `rem:todo` skill and the `rem` task system; do not track TODOs ad hoc.