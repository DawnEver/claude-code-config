---
name: looks-dead-but-isnt
description: Four things a "delete the dead code" pass would remove that are load-bearing — with the reason each must stay
metadata:
  type: project
  created: 2026-09-20
---

# Looks dead, is not — do not "clean these up"

A refactor pass (2026-09-20) set out to delete dead code. Four candidates were investigated and
**deliberately kept**. Each looks like unused baggage from inside this fleet, and each is
load-bearing for a reason that is invisible from here. Re-deleting them would be a real
regression.

## 1. `strippedFromPayload` / the payload-normalising branch (`codex-config-file.mjs`)

Unreachable today: the shared `codex_config.toml` is already a pure head, so `leaked > 0` never
fires. It is not dead code — it is a **guard whose trigger is currently absent**, normalising the
payload whenever machine state gets hand-pasted back into it. Deleting a self-healing guard
because it has not fired lately is how the `fix-lsp-windows` situation happened.

## 2. `fabric/migrations/migrate.mjs`

Duplicates the config repo's `migrate-local-env-settings.mjs` and has already diverged (its copy
lacks `legacyKeys`/`newKeys`, which the root's caller needs). From inside this fleet it can never
match. **cc-market is public**: a user who installs fabric without ever installing the config repo
has no other path off the retired `env:<provider>` shape. Same self-containment reason
`shared/lib.mjs` is bundled per plugin.

## 3. The dormant plugins

`watch`, `cc-latex`, `cc-academia`, and the three LSPs (`typescript`, `pyright`,
`rust-analyzer`) are installed or present but never enabled. They are **capabilities that are
currently off**, not dead code. The user's standing boundary: delete dead code freely, but ask
before removing a dormant capability.

## 4. `[marketplaces.*]` in `codex_config.toml`

Codex writes `last_updated` / `last_revision` / `source_type` there, and the whole table
currently rides the shared payload. Splitting it looks like the obvious fix and is a trap:

- **Whole table → local**: strips `source_type`, which a fresh host needs to know where the
  marketplace comes from. Same mistake the `hooks` vs `hooks.state` note in that file already
  records.
- **Per key → local**: the partitioner works per table, so the state lines would be re-emitted
  without their `[marketplaces.*]` header, landing under whatever table precedes them —
  valid-looking TOML with the wrong meaning.

Documented at the site with the cost and the shape a correct fix needs (a per-key local channel
that re-emits the header). Not urgent: the worst case is a host believing the marketplace is at a
revision it is not, and Codex re-checks.

## The general shape

"Nothing references it" and "it can never fire" are different claims. The first is about code
reachability; the second may be about **a condition that has not recurred yet**. Before deleting,
ask which one you are looking at.

Related: [[doctor-invariants]], [[entry-guard-symlink-class]]
