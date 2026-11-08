---
name: onedrive-dropped-the-hard-linked-payload
description: 2026-11-08 the OneDrive names of claude_settings.json and claude_env_settings.json vanished; the repo-root hard-link mirror is the cause and is removed; doctor now FAILs a broken managed link
metadata:
  type: project
---
# OneDrive dropped the hard-linked payload (2026-11-08)

## What was seen
- The HUD vanished: `~/.claude/settings.json` and `~/.claude/claude_env_settings.json` are symlinks to
  `<OneDrive>/Sync/cc-config/`, and both targets were gone. That folder's mtime was 2026-11-08 10:58;
  it still held `codex_config.toml`, `private-markers` and `trusted-origins`.
- The repo-root `claude_settings.json` / `claude_env_settings.json` survived with link count 1 and the
  latest content (11-06 / 11-07): the halves of a hard-linked pair whose OneDrive name was deleted.
  The user restored the OneDrive files.

## Ruled out
- No cc-config code deletes a sync-dir file: `check-links.js` deletes nothing; `adoptSyncDir` only moves
  repo -> sync and never clobbers the sync copy; `~/.claude/sync-dir` unchanged since 08-30.
- No Claude or Codex session of that day touched the path; not in the local Recycle Bin.

## Cause
- `25f104f` (10-23) hard-linked every payload file into the repo root. OneDrive does not support hard
  links: a write through the repo name changes the file without OneDrive's watcher seeing it. The two
  files lost were exactly the two written through the repo name since; the three untouched ones survived.
  OneDrive's diagnostics counted 7 local file deletes that week (`numLcDeleteFile`); its detailed logs are
  obfuscated, so the exact trigger is inferred, not read. Same family as the 10-18 incident (a cloud
  download replaced a hard-linked file).

## Fix (pr/the-sync-payload-is-never-hard-linked)
- Removed `repoMirrorLinks` / `mirrorPayload`, the setup "Repo mirror" pass, the repo table in
  `healSyncLinks` and in doctor `checkLinks`. The payload has one name, in the sync dir.
- doctor `brokenLink`: a managed link whose target is gone FAILs as `link-broken`, naming the target.
- After merge, on each host: the repo-root payload copies are stray; compare each with the sync copy
  and delete it once identical (setup reports a stale repo copy, never deletes it).
- Still open: a host WITHOUT symlink rights hard-links `~/.claude` names into the sync dir
  (`createLink` fallback, `healSyncLink`) -- the same OneDrive hazard on those hosts.
