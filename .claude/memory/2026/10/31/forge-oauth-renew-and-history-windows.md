---
name: forge-oauth-renew-and-history-windows
description: Gitea OAuth renewal through git (no PATs) and resumable forge history windows
---
# Forge OAuth renewal and history windows (2026-10-31)

## Gitea credential (scripts/bridge/forges.mjs forgeToken)
- Gitea login is a Git Credential Manager generic-provider OAuth token (username OAUTH_USER),
  expiring within hours; the user's own `git pull` renews it silently via the refresh token.
- Two attempts ERASED the user's login: `git credential reject` + fill, and a `git ls-remote`
  run with `GCM_INTERACTIVE=never` / `GIT_ASKPASS=''` (forced non-interactive GCM skipped the
  renewal, git got a 401 and dropped the credential).
- The user FORBIDS read-only PATs: the reader must use the OAuth login.
- Fix d5f80b5: on a 401 the reader runs ONE `git ls-remote --heads <base>/<repo>.git` in the
  user's own environment (only GIT_TERMINAL_PROMPT=0), re-fills, reads once more; still 401
  -> reported. Never reject/approve. Network/5xx/429 keep 3 attempts (RETRY_DELAYS_MS).
  Live expiry->renew not yet observed; check daemon log next time the token expires.

## History windows (c2a0167)
- A read capped at MAX_PAGES used to move the cursor to now: a busy repo's year kept only
  its newest days. Now each window {name,key,branch,since,until} carries per-kind positions
  (false = done) and unfinished windows go to `rest` in the cursor file
  (`{[sourceId]: {at, rest}}`), continued next read.
- Gitea: page numbers within a fixed [since,until), resumed one page back (overlap).
  Commits `/commits?since&until`; PRs `/issues?type=pulls&since&before` (filters by UPDATED
  time but sorts by CREATED desc, so only page positions are valid, not an oldest-seen bound).
- GitHub: commits by GraphQL history cursor; PRs by search `updated:since..upto
  sort:updated-desc` - search caps 1000 results, so the position is the oldest updatedAt read.

## Open
- sharp-review reviewers fail with no Anthropic key (`python -m ai_lab.auth login anthropic`);
  committed work needs `--range`.
- One host's bridge daemon restarts every ~20 s; undiagnosed (suspect an external ensure loop).
