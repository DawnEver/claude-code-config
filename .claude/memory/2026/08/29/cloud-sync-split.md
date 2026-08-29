---
name: cloud-sync-split
description: Working tree moved out of OneDrive (2026-08-29) after the sync daemon corrupted .git; only a 3-file config payload still rides cloud storage. Four-tier file classification; bare-repo-in-OneDrive rejected; no cloud auto-detection by design.
metadata:
  type: project
---

# Moving the working tree out of cloud storage

Migration performed 2026-08-29. Commits `e38fc43` (the split) and `adb3d33` (18 review
fixes). Design doc: `docs/sync-architecture.md`. The durable invariants were crystallized
into `.claude/rules/rem/path-conventions.md` — this entry records the *evidence and the
reasoning*, not the rules.

## Root cause, with the damage that proved it

The tree lived at `<OneDrive>/Sync/claude/`. OneDrive replicated `.git/` along with
everything else. Git assumes exclusive local ownership of `.git/`; a sync daemon does not
honour that. Observed on the macOS host:

| Artifact | Meaning |
| --- | --- |
| `.git/index-G`, `index-G-2`, `index-Linxu's MacBook Air`, `-2` | conflict copies of the git index |
| `.git/FETCH_HEAD-G`, `-G-2`, `FETCH_HEAD-Linxu's MacBook Air-1..6` | conflict copies of `FETCH_HEAD` |
| `.git/logs/HEAD` frozen at 08-07 while commits ran to 08-27, plus `logs/HEAD-G` | **the reflog was overwritten — git's undo history was gone** |
| `origin/main-G` on GitHub | a host pushed a divergent branch instead of merging |
| local `main` 11 behind; working tree `+1111/−4106` vs origin | the local tree was a stale partial replica, not new work |

That last row is the one that nearly caused data loss: committing the "dirty" working tree
would have deleted ~4100 lines already published. Reconciliation was therefore
`git reset --hard origin/main` + `git clean -fd` — deliberately **without `-x`**, to preserve
gitignored secrets and `cc-market/`.

Note the framing: this is not a git bug and not a OneDrive bug. It is *two writers against
one non-atomically-replicated directory*.

## Four-tier classification

Getting this split right is most of the design — it shrank the cloud payload from "the whole
repo" to three files.

| Tier | Contents | Transport |
| --- | --- | --- |
| **A** tracked | `scripts/`, `skills/`, `system-prompt/`, `output-styles/`, templates, `GLOBAL-AGENTS.md` | GitHub |
| **B** payload | `claude_settings.json`, `claude_env_settings.json`, `codex_config.toml` (head only) | cloud sync |
| **C** machine-local | `~/.claude/claude_env_settings.local.json` (**all API keys**), `sync-dir` pointer, `_meta.json`, `MEMORY.md` | never leaves the host |
| **D** generated | `models.json`, `codex_config.toml`'s `[model_providers.*]`, `system-prompt/dist/` | rebuilt per machine |

Two consequences worth remembering: `models.json` is *purely derived* from
`claude_env_settings.json` and so drops out of the payload entirely; and because keys are
Tier C, **the payload contains no secrets at all** — which is what makes cloud-syncing it
acceptable.

## Rejected: a bare repo inside OneDrive

The obvious suggestion (`git init --bare` in OneDrive, treat it as a private remote) is
right in principle — OneDrive should carry a packed payload, not a live tree — but redundant
here: the repo already has `origin = github.com/DawnEver/claude-code-config`. GitHub *is*
the compact-packfile remote that idea is reaching for, and this repo is public anyway.

## Rejected: OneDrive auto-detection

`resolveSyncDir()` deliberately has no cloud-path sniffing. This repo is public; Dropbox /
iCloud / Syncthing / no-sync-at-all are equally valid. Auto-detection would also be
ambiguous with several OneDrive accounts mounted, and silently surprising for someone who
has OneDrive installed but does not want config in it. An explicit pointer file costs one
command per machine and is auditable.

The repo-root fallback is what keeps a single-machine install byte-identical to the
pre-migration behaviour — there is a regression test guarding exactly that.

## Migration state as of 2026-08-29

- macOS host done; tree at `~/Documents/Code/AI/cc-config`, payload at `<OneDrive>/Sync/cc-config/`.
- `<OneDrive>/Sync/claude/` deliberately retained as the rollback.
- G and WS1 (`duip622037`) not yet migrated. Tooling for them lives in the payload dir:
  `migrate-host.mjs`, `rescue-cc-market.mjs`, `HANDOFF.md`, `READ-ME-FIRST.md`.
- The old tree is **not inert**: `setup.js` runs `git pull` inside `<sourceDir>/cc-market`
  on every run, so an un-migrated host keeps exercising git inside cloud storage. Delete
  `cc-market` there **first**, the parent folder second.
