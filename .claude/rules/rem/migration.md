# Migration Tooling

## `npm run migrate` / `/migrate` skill

`skills/migrate/migrate.js` ("migrate to latest only", no version-range bookkeeping):

- `migrateRepoLinks()` — removes orphaned `~/.claude`/`~/.codex` symlinks whose dest is no
  longer in the current repo layout, then re-runs `setup()`.
- `migrateOrphanedAliases()` — removes wrapper files this repo wrote (they carry a marker)
  whose name is no longer in `KNOWN_ALIAS_NAMES`. This is why `cogmi` was removed without
  leaving `cogmi.cmd` behind. It sweeps the claude bin dir, so on a Codex-only host it is a
  no-op — the wrappers there live in codex's bin dir.
- `migrateProject(cwd)` — scans `<repo>/cc-market/*/migrations/migrate.mjs` and calls each
  one with `cwd` as `projectRoot`. It does **not** consult
  `~/.claude/plugins/installed_plugins.json`; discovery is by directory, so a plugin's
  migration runs for every project regardless of whether it is installed there.

It no longer touches `enabledPlugins`. The retired-plugin swap it used to perform
(`takeover@cc-market` → `fabric@cc-market`) can no longer match anything: that plugin is
gone from cc-market, and the settings file is shared by every host, so no host can
reintroduce it.

## Per-plugin migration convention

`<plugin>/migrations/migrate.mjs` exports `async function migrate(projectRoot) -> {changed,
summary}`, idempotent/self-detecting, no-op once current. When a plugin makes a breaking
`.claude/` format change, fold the migration into its existing `migrations/migrate.mjs`
(additive, no chained version steps) rather than creating a new versioned migration file.

## Plugins auto-update

Claude Code built-in `autoUpdate` replaces the old `update-plugins-hook.js` — no need to
re-add manual plugin update hooks.

## Stamp-memory deprecated

`stamp-memory.js` no longer stamps frontmatter fields — volatile metadata (`accessed`,
`count`, `tier`) lives in gitignored `_meta.json`. `stamp-memory.js` now only warns on
missing `name:` and rebuilds MEMORY.md indexes. See `scope-isolation` memory entry for full
design.
