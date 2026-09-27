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

Read `git diff origin/main..HEAD`. Analyze the diff and commit messages to identify logical units.

- **Few commits (≤5) or one cohesive change** → propose a single squash commit. This is the default for small branches.
- **Many commits (>5)** → split into logical commits by default, not squash. Identify
  boundaries from the diff: different modules/packages/directories, different features, or
  otherwise independent changes. Group by what changed (module, feature), not by change type
  (feat/test/docs). A feature's implementation and its tests belong together — don't split
  them. Aim for the fewest commits that keep unrelated modules and features apart. If unsure,
  keep them separate.

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
git add <files for module/feature A>
git commit -m "feat(scope-a): ..."
git add <files for module/feature B>
git commit -m "fix(scope-b): ..."
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
- Default to one commit for small branches (≤5 commits); split by module/feature for many commits
  (>5). Split by what changed, not by change type — a feature's code and its tests go together.
  Keep the split minimal.
- Rebase, don't merge.
- Prefer `git reset --soft` over interactive rebase for simple squashes — works identically on all platforms.
