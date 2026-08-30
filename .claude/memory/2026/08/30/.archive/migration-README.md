# scripts/migration — one-time per-host migration off cloud-synced working trees

Tooling for moving a machine off the old layout, where the git working tree lived inside
`<OneDrive>/Sync/claude/` and OneDrive replicated `.git/` between machines. See
`docs/sync-architecture.md` for the design and `docs/host-migration-handoff.md` for the
operator runbook.

| File | What it does |
| --- | --- |
| `migrate-host.mjs` | migrates ONE host: preflight → clone outside cloud storage → `setup.js --sync-dir` → verify |
| `rescue-clone.mjs` | decides whether an old cloud clone holds anything not on GitHub, and rescues stray branches out of it |
| `PAYLOAD-README.md` | the note that ships in the sync payload dir, for whoever opens it next |

## Two copies, on purpose

**This directory is the canonical copy** — it is version-controlled, so it survives the
cloud storage it exists to retire.

A working copy also lives in the sync payload dir (`<cloud>/Sync/cc-config/`), because
an un-migrated host must run `migrate-host.mjs` *before* it has cloned this repo. That copy
is the bootstrap; this one is the source of truth. After changing anything here, refresh it:

```
cp scripts/migration/migrate-host.mjs scripts/migration/rescue-clone.mjs "$(cat ~/.claude/sync-dir)/"
cp docs/host-migration-handoff.md "$(cat ~/.claude/sync-dir)/HANDOFF.md"
cp scripts/migration/PAYLOAD-README.md "$(cat ~/.claude/sync-dir)/READ-ME-FIRST.md"
```

Both scripts resolve the retired tree via `resolveOldRoot()` — `<script>/../claude` when
run from the payload dir, otherwise the `~/.claude/sync-dir` pointer — so they work from
either location.

## Lifetime

These are disposable. Once every host has migrated and
`node rescue-clone.mjs --delete` has removed the old trees, this directory and the payload
copies can go. Keep `docs/sync-architecture.md`, which documents the layout that remains.
