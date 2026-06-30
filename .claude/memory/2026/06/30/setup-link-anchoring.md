---
name: setup-link-anchoring
---

# Setup Link Anchoring Pitfalls

Two related failure modes in `scripts/setup/` symlink/alias installation, both
about *what a link is anchored to*.

## 1. Per-skill links resolve THROUGH a legacy whole-dir junction (issue #2, e903ee7)

We moved from linking the whole skills dir (`~/.codex/skills -> repo/skills`) to
linking each skill individually (`~/.codex/skills/<name>`). On installs that still
had the legacy junction, each per-skill destination `path.join(codexDir, 'skills/migrate')`
resolved *through* the junction back into `repo/skills/migrate`. `symlinkSync` then
created a **self-referential junction inside the repo**, clobbering the real skill
dir — Git reported tracked `SKILL.md`/migration files as deleted.

**Fix:** `ensureRealDir(dirPath)` in `setup.js` — if the path is a symlink/junction,
`unlinkSync` it, then `mkdirSync` a real directory. Called on `~/.codex/skills`
*before* the per-skill Codex linking loop. (`migrate.js`'s `findOrphanedLinks` already
self-heals the junction too, but the setup-time guard makes plain `npm run setup` safe.)

Rule: before creating links *inside* a directory that legacy versions may have linked
as a whole, convert that directory to a real dir first.

## 2. Alias installer must anchor to claude-OR-codex bin (79092bd)

`install-shell-aliases.js` anchored every wrapper to the `claude` binary's dir and
bailed entirely (`could not locate claude executable`) when only Codex was installed —
so provider-independent `todo`/`traceme` never reached PATH.

**Fix:** `resolveAliasBinDirs()` returns `{claudeBin, targetBin}` where
`targetBin = claudeBin || locate('codex')`. Install `todo`/`traceme` to `targetBin`
(works codex-only). Install `ccc`/`ccds` only when `claudeBin` exists — they spawn the
`claude` binary via `cc.js`, so they're inert without it. Bin lookup extracted to
injectable `locateBinDir(cmd, run)` for unit tests.

Rule: separate provider-independent CLI tools from claude-bound launchers; anchor the
former to any available host bin, the latter only to claude's.
