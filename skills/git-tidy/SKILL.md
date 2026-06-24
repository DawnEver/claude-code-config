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

Read `git diff origin/main..HEAD`. Choose a target shape based on how much is on the branch:

- **Few commits (≤5) or one cohesive change** → propose a single squash commit. This is the default.
- **Many commits (>5) or clearly separable concerns** → propose splitting into a few logical
  commits, one per concern (e.g. feature vs. test vs. docs vs. unrelated fix). Group by what the
  diff touches, not by the original commit boundaries. Keep the count small — aim for the fewest
  commits that keep unrelated changes apart.

Each proposed commit uses:

```
<type>(<scope>): <imperative description>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `perf` `style` `ci` `build`

Present the proposed commit(s) as a list and **ask for confirmation before touching history.**

### 3. Execute (after confirmation)

```bash
git reset --soft origin/main
git commit -m "feat: your message here"
```

This squashes everything — including any WIP commit from Step 0 — into one clean commit.

**For a split into multiple commits**, `reset --soft` then stage each concern separately:

```bash
git reset --soft origin/main   # unstage everything, keep working tree
git restore --staged .         # move all changes to unstaged
git add <files for concern 1>
git commit -m "feat: ..."
git add <files for concern 2>
git commit -m "test: ..."
# repeat per concern
```

If concerns are interleaved within the same file, use `git add -p` to stage hunks. Avoid
interactive rebase for splits — staging from a soft reset works identically on all platforms.

### 4. Verify and push

```bash
git log --oneline origin/main..HEAD
```

Push only on request:
- First push: `git push origin HEAD`
- Rewritten: `git push --force-with-lease origin HEAD` — never `--force`

## Rules

- Never rewrite without confirmation.
- Default to one commit; split into a few logical commits when the branch has many commits (>5)
  or clearly separable concerns. Keep the split minimal.
- Rebase, don't merge.
- Prefer `git reset --soft` over interactive rebase for simple squashes — works identically on all platforms.
