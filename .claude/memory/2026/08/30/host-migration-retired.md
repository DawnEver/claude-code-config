---
name: host-migration-retired
description: The cloud-git migration finished 2026-08-30 when host G moved onto the split layout; all three hosts are done, so scripts/migration/ and the payload bootstrap copies were retired into .claude/memory/2026/08/30/.archive/. Records two defects the last host surfaced.
metadata:
  node_type: memory
  type: project
---

# Host migration retired — all three hosts on the split layout

The move off cloud-synced git working trees (see [[cloud-sync-split]] for the layout and
[[sync-restructure-three-tenancies]] for why) is **complete as of 2026-08-30**:

| Host | Migrated | Working tree |
| --- | --- | --- |
| macOS | 2026-08-29 | — |
| WS1 `duip622037` | 2026-08-29 | `C:\Users\ezxmb14\Documents\MingyangBao` — see [[windows-launcher-quoting-and-links]] |
| G | 2026-08-30 | `C:\Users\linxu\Documents\AI\{cc-config,ai-agents}` |

`scripts/migration/README.md` declared the tooling disposable once every host had migrated
and the old trees were gone. Both conditions held, so it was retired.

## Where the tooling went

Archived verbatim in `.claude/memory/2026/08/30/.archive/`:

| File | Was |
| --- | --- |
| `migrate-host.mjs` | `scripts/migration/` |
| `rescue-clone.mjs` | `scripts/migration/` |
| `migration-README.md` | `scripts/migration/README.md` |
| `PAYLOAD-README.md` | `scripts/migration/PAYLOAD-README.md` (shipped as payload `READ-ME-FIRST.md`) |
| `host-migration-handoff.md` | `docs/` (shipped as payload `HANDOFF.md`) |
| `host-migration-agent-prompt.md` | `docs/` (shipped as payload `AGENT-PROMPT.md`) |

The `.archive/` name is load-bearing: `collectMemoryFiles()` in `cc-market/rem/scripts/lib.mjs`
does `if (entry.name.startsWith('.')) continue`, so a dot-prefixed directory is skipped by the
index walker while `.gitignore`'s `!**/.claude/memory/**` still tracks its contents. That is how
raw `.mjs` and un-frontmattered `.md` live under `memory/` without polluting `MEMORY.md`.

**Kept:** `docs/sync-architecture.md` — it documents the layout that remains, not the one-time move.

## Two defects the last host surfaced

**`npm run migrate` does not clean `.setup-bak` files.** Its orphan sweep only removes dangling
*symlinks*, but `setup.js --replace` leaves `plugins/claude-hud/config.json.setup-bak` as a plain
*file* ("kept unlinked copy"). The §4 checklist claims migrate handles it; it does not. Had to be
removed by hand. If the sweep is ever extended, this is the case to cover.

**A deleted cloud folder gets resurrected by live apps through dangling symlinks.** After OneDrive
propagated the delete of `Sync/claude`, the folder reappeared holding a 72-byte `claude_settings.json`
and a `codex_config.toml` with one `[projects.*]` block — both written *by running Claude/Codex
processes* through `~/.claude` symlinks that still pointed there. They look like survivors of the old
tree and are not. **Repoint the links before concluding anything about what a retired tree contains**,
and re-check after: the files carry the current timestamp, which is the tell.

## Verifying a host is really on the new layout

`git status` is not the check ([[cloud-git-forensics]] explains why it lies). What actually settles it:

```
cat ~/.claude/sync-dir                       # must name the payload dir
[ -L ~/.codex/config.toml ] && echo BAD      # must be a real file, composed per host
find ~/.claude ~/.codex -maxdepth 4 -type l ! -exec test -e {} \; -print   # dangling links
find "<OneDrive>/Sync" -name .git            # must be empty — the invariant
```

Handoff docs pin a test count (it said **151**); the repo had **170** by the time G migrated. Treat a
count mismatch as doc drift, not failure — `fail 0` is the gate.
