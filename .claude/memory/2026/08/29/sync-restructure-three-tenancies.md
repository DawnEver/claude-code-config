---
name: sync-restructure-three-tenancies
description: The OneDrive Sync folder held three things with incompatible needs — git working trees, small shared config, and 884M of local-only data — under one mechanism; separating them by need is what actually fixed the problem, not moving the repo
metadata:
  type: project
---

# Sync/ held three tenancies, not one

The earlier entry (`cloud-sync-split`) framed this as "move the config repo out of
OneDrive". That was only a third of it. Completing the job on 2026-08-29 required surveying
the whole `Sync/` folder, and the real diagnosis is structural.

## What was actually in there

| | Contents | Size | Needs | Must not |
| --- | --- | --- | --- | --- |
| **A** git working trees | `Sync/claude` (+ `cc-market`), `Sync/agents` | 38M + ~10M | exclusive `.git` | be replicated by a sync daemon |
| **B** small shared config | 3 payload files | 72K | cross-machine sync | — |
| **C** bulk local-only data | archives, PDF corpora, PII transcripts | **884M** | **backup** | be in git (size, PII) |

The mistake was never "using OneDrive". B and C genuinely want cloud storage. The mistake
was putting all three in one folder and letting one mechanism serve all of them — which
broke A, the only tenant that cannot tolerate it.

`Sync/agents` made this vivid: 997M total, **393 tracked files**. Deleting the folder
outright — the initial instinct — would have destroyed ~884M that GitHub never had, some of
it deliberately (`agents/.gitignore`: *"cc-docx workspace transcripts contain real contact
emails, project paths and partner/people names — local-only by choice"*).

## The resulting layout

```
~/Documents/Code/AI/          git working trees, never synced
  cc-config/  ai-agents/

<OneDrive>/Sync/              no .git anywhere — the invariant
  cc-config/    72K   config payload + migration tooling
  agent-data/  215M   bulk data, joined back by gitignored symlinks
```

`ai-agents/scripts/link-agent-data.sh` recreates the six symlinks after a clone, resolving
the data dir from an argument, `$AGENT_DATA_DIR`, or the `~/.claude/sync-dir` pointer's
sibling — so it works across the fleet's mixed usernames.

Kept: `ai-post/archived`, `reply-email/archived`, `manuscript-review/{archived,ongoing}`,
`cc-docx` (777 files, 215M). Dropped deliberately: `literature-review/ongoing` (668M of
re-downloadable papers) and `cc-lab/node_modules`.

## `ai-agents` had the identical corruption

Its index held **393 entries against 284 real files**: `reviewer-discovery/` reported as
untracked and three committed memory files reported as *staged deletions* — all five and
all three present on the remote. Verified `SAFE` (0 unpushed, 0 orphans) before deletion.

Same signature as the config repo, found by the same tooling. Worth expecting on any repo
that has lived in a sync folder.

## Two corrections worth remembering

**The naming.** The intended location (`~/Documents/Code/AI/`) was stated at the outset and
missed; the trees first landed in `~/Projects/`. Correcting it meant editing 12 references —
tooling defaults, docs, and the always-injected `path-conventions.md` rule — because a wrong
default in migration tooling propagates to every host that runs it. Later renamed
`claude-config` → `cc-config` for consistency with the `cc-*` family; the GitHub repo keeps
its name.

**Superseded ≠ unique.** Three `cc-market` branches held 13 unpushed commits whose tree
objects were not in published history, which read as "unique work". They were the fabric
plugin's development history from 2026-07-08; fabric has been in `main` and under active
development ever since. The tree differed only because the old clone's `origin/main` ref was
stale, so the diff was really "everything after July 8", reversed. Check *dates and
downstream state*, not just object reachability, before calling something irreplaceable.
