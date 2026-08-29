---
name: codex-config-three-way-split
description: codex_config.toml is machine-WRITTEN, not hand-edited — 30 [projects.*] trust blocks across two usernames and three drive letters. Split by owner; ~/.codex/config.toml is composed per host. Records the TOML parser hazards a review caught before they shipped.
metadata:
  type: project
---

# codex_config.toml is three files wearing one filename

Recorded 2026-08-29, during the cloud-sync migration. The rule-level summary is in
`.claude/rules/rem/path-conventions.md` § 3; this entry keeps the *evidence* and the
parser hazards, which are the reusable part.

## The wrong assumption, and what disproved it

The obvious classification — "it is a config file, therefore hand-edited, therefore share
it" — was wrong, and a review caught it before the first cross-machine sync.

Codex **writes to this file itself**. It appends a `[projects.'<absolute path>']` trust
block on every new project directory it visits, plus `[hooks.state.*]` and `[notice]`
runtime state. The live file held:

- **30** `[projects.*]` blocks, spanning two usernames (`linxu`, `ezxmb14`) and three drive
  letters (`c:`, `d:`, plus macOS `/Users/...`)
- 8 `[hooks.state.*]` blocks, 1 `[notice]`
- 21 Windows absolute paths vs 4 macOS ones in a single file

Cloud-syncing that reproduces the exact two-writers problem the migration exists to
eliminate — just at lower frequency — and permanently accretes every other host's dead
paths.

## The split, by owner

| Part | Owner | Where |
| --- | --- | --- |
| preamble + `[tui]`, `[plugins.*]`, `[features]`, … | human | payload (Tier B) |
| `[model_providers.*]` between the setup-managed markers | `claude_env_settings.json` | generated (Tier D) |
| `[projects.*]`, `[hooks.state.*]`, `[notice]` | Codex itself | machine-only (Tier C) |

Splitting the live 198-line file yielded an **82-line shared head** — exactly the section
set the tracked template already declares — and 39 machine-local sections that stop
travelling. `~/.codex/config.toml` is therefore a **composed real file**, not a symlink:
shared head + generated block + this host's own state. `sharedHeadOf()` is idempotent and
also runs against the payload every setup, so state leaked in by an older host is stripped.

Code: `scripts/setup/codex-config-compose.mjs` (pure text) and
`scripts/setup/codex-config-file.mjs` (filesystem side, kept separate because setup.js was
already 600 lines mixing symlinks, user-data migration and TOML composition).

## Parser hazards — the expensive part

The splitter's output is written back over a **cloud-synced** file, so a misparse is not a
local annoyance, it is fleet-wide data loss. Every one of these was found by review and
fixed before shipping:

1. **Header-looking line inside a `"""` multi-line string.** A line that is exactly
   `[projects.x]` at column 0 inside a string used to be treated as a table header: the file
   split mid-string, the closing delimiter went to a different bucket, and **unterminated
   TOML** was written over the payload. Reproduced: 51 chars in, 31 out, delimiters
   unbalanced. Fixed by tracking `"""` / `'''` state in the line scanner.
2. **`hooks` as a prefix was too broad.** It claimed the whole namespace, so user-authored
   `[hooks]` / `[hooks.on_start]` config was silently deleted from the shared head.
   Narrowed to `hooks.state`.
3. **`[model_providers.*]` outside the markers** was classified as shared, baked into the
   payload, and then collided with the regenerated block — duplicate TOML tables, fleet-wide.
   Now always treated as generated regardless of position.
4. **Trailing comments** (`[tui]  # theme`) were not recognised as headers, which both
   leaked machine-local paths into the payload and collapsed the rest of the file into the
   preamble.
5. **`[[array-of-tables]]`** must be left as ordinary content, never mis-split.

Two structural defences beyond the individual fixes, both worth reusing anywhere a derived
file overwrites a shared one:

- `partition()` assigns **every** input line to exactly one bucket, so reconstruction is
  lossless by construction rather than by inspection.
- `assertLossless()` refuses to rewrite when a split would strand a multi-line string, and
  writes go through tmp+rename with a `.pre-split-bak` the first time content is discarded.

## Preserving project trust on first upgrade

On a not-yet-migrated host, `~/.codex/config.toml` is still a symlink into the shared tree,
whose `[projects.*]` list belongs to the whole fleet. The first implementation discarded all
of it (avoiding 30 dead paths) — which also threw away that host's own trust decisions.
Corrected to **filter by path existence**: keep entries that resolve on this host, drop the
rest. On macOS: 1 kept, 29 discarded.
