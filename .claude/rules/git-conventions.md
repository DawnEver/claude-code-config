# Git Conventions

## Use Bash for commits
Always use the Bash tool (not PowerShell) for `git commit`.

**Why:** PowerShell here-strings (`@'...'@`) leak `@` into the commit message. Use Bash HEREDOC:
```bash
git commit -m "$(cat <<'EOF'
fix: description here
EOF
)"
```

## Commit message style
- Imperative, conventional commits (`feat:`, `fix:`, `docs:`, `chore:`)
- Pass messages with `-m "..."` using double quotes
- Never force-push shared branches; use `--force-with-lease` if unavoidable
