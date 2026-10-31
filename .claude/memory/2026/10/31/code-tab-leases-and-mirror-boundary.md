---
name: code-tab-leases-and-mirror-boundary
description: Code tab forge reads leased by the gateway, git-style credential renewal, Telegram mirror turn boundary, dashboard redraw rules
---
# Code tab + bridge fixes (2026-10-30/31)

## Forge reads: one host per source per interval (registry.mjs)
- Hosts declare `forges.sources` (sourceId = `kind|host[:port]|owner|repos`, `|` because hosts
  may carry ports) in each push; the gateway keeps ONE record per source in DO storage and
  leases a due source (no good reading within 5 min, no live lease) to the pushing host via the
  reply's `forgeRead`. Lease 2 min (dead host replaced), skip 30 min for a host that reports
  unavailable/refused, forget a source undeclared for 24 h (stored when forgotten).
- Readings ride the push from an outbox until accepted; a reading replaces the record whole
  (idempotent); an error never replaces a good reading; "no host can read it" shows reasons.
- Credentials = what the host's git uses: `gh auth token`, else `git credential fill` for the
  forge host. The Gitea one is a GCM OAuth token (provider generic) that expires in hours.
- NEVER `git credential reject` it ourselves: done once with GCM_INTERACTIVE=never, GCM could not
  renew outside git's flow and the user's git login was deleted ("no token"). A plain `git pull`
  renewed it silently (new fingerprint, API 200). So on 401 the reader runs a non-interactive
  `git ls-remote` of a listed repo (git's own flow) and re-reads; store never written.
  Unverified end-to-end on a real expiry; fallback = read-only PAT named by keyUsername.
- Every forge request retries network/timeout/5xx/429 twice (1 s, 3 s); 401/404 not retried.
- Lesson: a failed read with no pushedAt was filtered out by the activity range -> silent.
  Unread repos now always show; the daemon logs one `forges:` line per reading.

## Telegram mirror repeated the previous answer
- bridge-hook `turnTexts` started the turn at the last non-meta user entry; a Telegram message
  is `isMeta` (channel origin, or "Stop hook feedback:\nMessage from Telegram"), and so is any
  plugin Stop-hook continuation. Each of those now starts the text to mirror.

## Dashboard
- A row toggle redraws that row only (`foldRow` rebuilds itself via `replaceWith`); render()
  draws only the tab in view and keeps scrollY; saved-position restore lands once (≤20 tries).
- One interaction CSS block (hover/press/focus); one `.columns` layout with `--col: 340px`.
- Repo tap -> Sessions filtered to its project; chevron button opens detail; forge items open
  the forge; a session inside an item opens its Topic (stopPropagation).
- Repo choice per device (Config › Code, default = source `show`); Needs attention off by default.
- Policy kept: channel messages never count as approval (bridge rule); user was told.
- sharp-review: the merge drops every finding when the plan's rule-id list is empty; reviewers'
  raw findings were real each time (4 + 1 fixed).
