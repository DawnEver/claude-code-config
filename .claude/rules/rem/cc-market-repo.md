# cc-market is a Separate Git Repo

`cc-market/` is gitignored by this repo and is its own standalone git repository
(`DawnEver/cc-market`). When making changes to plugins (watch, rem, sharp-review, takeover,
traceme), commit them inside `cc-market/`:

```bash
git -C cc-market add <files>
git -C cc-market commit -m "..."
```

**Why:** `cc-market/` is cloned by setup as a community marketplace and is gitignored from
this config-sync repo (`.gitignore` line: `cc-market/`). Changes to plugins live in the
cc-market repo, not here.

**How to apply:** Always use `git -C cc-market` when committing plugin changes. This repo
has no visibility into cc-market files. Note also that `~/.claude/plugins/cache/cc-market/`
and `~/.claude/plugins/marketplaces/cc-market` are SEPARATE clones that lag behind this dev
clone — a bug already fixed here may still reproduce from the cached/installed copy until
that clone pulls the new commit.
