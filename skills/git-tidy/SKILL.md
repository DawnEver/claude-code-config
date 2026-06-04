---
name: git-tidy
description: >
  Use when the user wants to tidy git history before merging or pushing: squash/rebase commits,
  consolidate WIP commits, fix messages, use conventional commits, or prepare a PR.
---

Clean up branch history relative to `origin/main` into a linear, well-named history.

## Steps

### 0. Absorb uncommitted changes

```bash
git status --short
```

If dirty: show the file list, then stage and snapshot — **never skip this**:

```bash
git add -A
git commit -m "wip: absorb uncommitted changes"
```

Only ask if something suspicious appears (build artifacts, `.env`, unrelated files). This WIP commit gets squashed in Step 3.

### 1. Orient

```bash
git fetch origin
git log --oneline origin/main..HEAD
```

Report: total commits, which look like WIP (`wip`, `fix`, `temp`, `xxx`, single words, `…`), which are already conventional.

### 2. Propose

Read `git diff origin/main..HEAD`. Propose a single squash commit:

```
<type>(<scope>): <imperative description>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `perf` `style` `ci` `build`

If the diff clearly covers unrelated changes, mention it and offer to split — but default is one commit. **Ask for confirmation before touching history.**

### 3. Execute (after confirmation)

```bash
git reset --soft origin/main
git commit -m "feat: your message here"
```

This squashes everything — including any WIP commit from Step 0 — into one clean commit.

For multiple commits: use `GIT_SEQUENCE_EDITOR` with a temp script (Bash) or `git config sequence.editor` (Windows) to drive `git rebase -i origin/main` non-interactively.

### 4. Verify and push

```bash
git log --oneline origin/main..HEAD
```

Push only on request:
- First push: `git push origin HEAD`
- Rewritten: `git push --force-with-lease origin HEAD` — never `--force`

## Rules

- Never rewrite without confirmation.
- Default to one commit; split only if user asks.
- Rebase, don't merge.
- Prefer `git reset --soft` over interactive rebase for simple squashes — works identically on all platforms.
