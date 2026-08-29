---
name: cloud-git-forensics
description: In a cloud-corrupted git clone `git status` lies three separate ways. Technique — ask "does this content exist in the published history?" via git hash-object + blob lookup, scoped by git ls-files, with placeholders detected by stat blocks===0.
metadata:
  type: project
---

# Auditing a git clone that lived in cloud storage

Developed 2026-08-29 while deciding whether the old `<OneDrive>/Sync/claude/cc-market`
clone held any unpublished work. This is the most reusable thing to come out of the
migration: it applies to **any** repo that was ever synced by a file-sync daemon.

## `git status` lies, in three independent ways

Do not trust it. Each of these produced a wrong conclusion in turn:

1. **Stale `.git` over newer content.** `HEAD` sat at a commit from 08-09 while the cloud
   client had synced *down* newer, already-published file content from another machine.
   `git status` duly reported 46 files as "modified". They were verbatim content of real
   published commits.
2. **Placeholders abort it entirely.** Files-On-Demand files that were never downloaded make
   `git status` fail with `error: read error while indexing <path>: Operation timed out`,
   exit **128**, and **no status output at all** — a clean-looking failure that is easy to
   misread as "nothing to report".
3. **CRLF vs LF.** Windows hosts wrote CRLF; a Unix clone has LF. Every such file diffs as
   `1,219c1,219` — all lines changed. The tell is the byte count: **+1 byte per line**.

## The right question

Not *"does this differ from HEAD"* but **"does this content exist anywhere in the published
history?"** Hash each file and look the blob up in a trustworthy reference clone:

```
git hash-object --stdin  <  file      # then, in the reference clone:
git cat-file -e <hash>                # exit 0 => this exact content was published
```

Try the raw bytes and both line-ending normalisations before concluding a file is novel.

## Two mistakes that cost a round each

- **Detect placeholders with `stat`, never by reading.** A dehydrated file reports its
  logical size but occupies zero blocks: `s.size > 0 && s.blocks === 0`. Reading one blocks
  on a network fetch and only fails after a long timeout — a first pass that read them
  serially ran for minutes without finishing; the `stat` check is instant. (Verified: a
  dehydrated file showed `size 8450, blocks 0`; a normal one `size 10092, blocks 24`.)
- **Scope with `git ls-files`, never a filesystem walk.** Walking the tree swept in
  gitignored artefacts — `.venv/`, `__pycache__/`, `.claude/memory/**/_meta.json` — none of
  which are "work" and none of which are in history. That produced **589 phantom
  "unpublished" files and a false STOP verdict**. Use `git ls-files` plus
  `git ls-files --others --exclude-standard`; both read only the index, so placeholders
  cannot break them.

## Verdict on the old cc-market clone

| Category | Count |
| --- | --- |
| unpushed commits | 0 |
| identical to remote HEAD | 491 |
| differ only in line endings | 30 |
| match an older published commit (stale cloud sync) | 46 |
| **content in no published commit** | **0** |

SAFE — and yet **not deleted**. 115 *tracked* files under `cc-academia/` (src, tests,
`uv.lock`) are placeholders macOS never downloaded. Their committed content is safe in git;
what cannot be checked from here is whether a host that *has* them left uncommitted edits.
Since G/WS1 use the OneDrive folder **as** their working tree, such edits would exist
nowhere else. A placeholder can only be verified on the host where it is real — so each
host runs the check itself, and the last one deletes.

Tool: `<payload>/rescue-cc-market.mjs` (`--delete` to act on a SAFE verdict). Invoked
automatically by `migrate-host.mjs`.

## Corollary

cc-market needed no migration of its own: it is a separate repo that `setup.js` clones
*into* the working tree, so it followed the tree out of cloud storage automatically. The
plugin marketplace is registered by GitHub repo (`DawnEver/cc-market`), not by filesystem
path, so nothing on the plugin side referenced OneDrive either.
