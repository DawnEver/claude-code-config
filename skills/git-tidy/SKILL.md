---
name: git-tidy
description: >
  Use when the user wants to tidy git history before merging or pushing: squash/rebase commits,
  consolidate WIP commits, fix messages, use conventional commits, or prepare a PR.
---

Helps clean up a branch's commit history relative to the remote main branch, producing a
linear, well-named history ready to push or merge.

## Workflow

### 0. Absorb uncommitted changes

Before doing anything else, check for uncommitted changes:

```bash
git status --short
```

If there are staged or unstaged modifications, **amend them into the current (HEAD) commit**
rather than leaving them floating or creating a new WIP commit:

```bash
git add -A
git commit --amend --no-edit
```

Ask the user first if the working tree is dirty — they may want to stash or exclude certain
files. But the default assumption is: uncommitted work belongs to the commit in progress and
should be folded in before tidying history.

### 1. Orient

```bash
git fetch origin
git log --oneline origin/main..HEAD
```

Show the user the commits on their branch vs. remote main. Count them. Identify WIP commits
by scanning for messages matching patterns like: `wip`, `fix`, `temp`, `asdf`, `xxx`,
`cleanup`, `changes`, `update`, `stuff`, `test`, single words, or messages ending in `…`.

Report a brief summary:
- Total commits on branch
- Which look like WIP/fixup candidates (list them)
- Which already have good conventional format

### 2. Propose a single-commit consolidation plan

**Default: squash all branch commits into one.** Read the combined diff of all commits
(`git diff origin/main..HEAD`) to understand the net change, then propose a single
conventional commit message that captures the intent.

Conventional commit format:
```
<type>(<optional scope>): <imperative description>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`, `ci`, `build`

**Example:**
```
Before:
  abc1234 wip
  def5678 add login form
  ghi9012 fix login form validation
  jkl3456 more fixes

After (proposed):
  → feat(auth): add login form with validation   [squash all 4 commits]
```

If the diff is large and clearly covers multiple unrelated changes, mention it and offer to
split into separate commits — but the default is still one commit. Let the user decide to
split if they want.

Present the proposed message and **ask for confirmation** before touching anything. Let the
user adjust the wording. This is their history — don't be presumptuous.

### 3. Execute (only after user confirms)

Warn: "This rewrites history. Make sure you haven't pushed these commits to a shared branch,
or use --force-with-lease when pushing."

Squash the entire branch into one commit:

```bash
git reset --soft origin/main
git commit -m "feat: your message here"
```

If the user asked to keep multiple commits, use `git rebase -i origin/main` and generate a
rebase todo script programmatically — write the pick/squash/reword instructions to a temp
file and apply via `GIT_SEQUENCE_EDITOR`:

```bash
cat > /tmp/rebase-todo.sh << 'EOF'
#!/bin/sh
cat > "$1" << 'SCRIPT'
pick abc1234 feat(auth): add login form
squash def5678 wip
reword jkl3456 old message
SCRIPT
EOF
chmod +x /tmp/rebase-todo.sh
GIT_SEQUENCE_EDITOR=/tmp/rebase-todo.sh git rebase -i origin/main
```

### 4. Verify and optionally push

After rebasing, show `git log --oneline origin/main..HEAD` again so the user can confirm
the result looks right.

If the user wants to push:
- If the branch has never been pushed: `git push origin HEAD`
- If it was previously pushed: `git push --force-with-lease origin HEAD`

Always confirm before pushing. Remind about `--force-with-lease` safety: it fails if someone
else pushed to the branch since your last fetch, preventing accidental overwrites.

## Key principles

- **Never rewrite without explicit confirmation.** Show the plan first, ask, then act.
- **Preserve meaning.** When grouping commits, read the diffs if needed to write accurate messages.
- **Default to one commit.** Squash the entire branch into a single conventional commit
  unless the user explicitly asks to split. Most branches represent one logical change;
  WIP fixups are noise, not independent work.
- **Rebase, don't merge.** Linear history is the goal.
- **Use `--force-with-lease`**, never `--force`, when push is needed after rebase.

## Windows / cross-platform note

On Windows with PowerShell, use `$env:GIT_SEQUENCE_EDITOR` instead of the shell export, or
use the `git config` approach:
```powershell
git config sequence.editor "path/to/script"
git rebase -i origin/main
git config --unset sequence.editor
```

Prefer the `git reset --soft` approach for simple cases — it avoids interactive rebase
complexity entirely and works identically on all platforms.
