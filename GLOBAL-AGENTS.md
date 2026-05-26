# Global Preferences

## Language
- Output code and file contents in English unless explicitly asked otherwise.
- Conversation can be in any language the user prefers.

## Code Style
- Write clean, minimal, elegant code with unnecessary comments.
- Prefer editing existing files over creating new ones.

## Workflow
- Use LSP if available.
- Aggressively use subagents for high-token-cost operations whose results only need summaries, keeping that work in the subagent's independent context.
- Update README.md and memory after finishing tasks.
## Git Hygiene
- Linear history: rebase over merge, squash WIP commits before finishing.
- Commit messages: imperative, conventional (`feat:`, `fix:`, `docs:` …), passing messages directly with `-m "..."` using double quotes.
- Never force-push shared branches; use `--force-with-lease` if unavoidable.