---
name: cc-market-separate-repo
description: cc-market is a separate git repo; changes must be committed there, not in the parent repo
metadata:
  type: project
created: 2026-06-07
accessed: 2026-06-07
tier: short
---

# cc-market is a separate git repo

`cc-market/` is gitignored by the parent repo and is its own standalone git repository. When making changes to plugins (watch, rem, sharp-review, takeover), commit them inside `cc-market/`:

```bash
git -C cc-market add <files>
git -C cc-market commit -m "..."
```

**Why:** `cc-market/` is cloned by setup as a community marketplace. It's gitignored from the parent config-sync repo (`.gitignore` line: `cc-market/`). Changes to plugins live in the cc-market repo, not the parent.

**How to apply:** Always use `git -C cc-market` when committing plugin changes. The parent repo has no visibility into cc-market files.
