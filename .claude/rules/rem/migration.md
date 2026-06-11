# Migration Tooling

## `npm run migrate` / `/migrate` skill

`skills/migrate/migrate.js` ("migrate to latest only", no version-range bookkeeping):

- `migrateRepoLinks()` — removes orphaned `~/.claude`/`~/.codex` symlinks whose dest is no
  longer in the current repo layout, then re-runs `setup()`.
- `migrateProject(cwd)` — reads `~/.claude/plugins/installed_plugins.json`, finds
  `<plugin>@cc-market` entries relevant to `cwd`, and calls `migrate(projectRoot)` from each
  plugin's `migrations/migrate.mjs` if present.

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
