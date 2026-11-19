# cc-market is a separate family repo

cc-market (`DawnEver/cc-market`) is its own repository, checked out beside the other family repos,
never inside this one. Its one location is the machine file's `[repos] cc-market`
(`python -m dev_lab.dev.devhost local set repos.cc-market <path>`); `scripts/shared/market-dir.mjs`
reads it for setup, doctor, agy, migrate and the plugin launcher. Commit plugin changes there:

```bash
git -C <declared cc-market checkout> add <files>
git -C <declared cc-market checkout> commit -m "..."
```

**Why:** two clones of one repo drift (user, 2026-11-19: keep one). An undeclared location is refused by
name with its door, never guessed.

**How to apply:** `~/.claude/plugins/marketplaces/cc-market` and `~/.claude/plugins/cache/cc-market/` are
the installed copies Claude pulls from GitHub; they lag the checkout until it lands and they update.
