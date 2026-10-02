# Coordination view: a push and its verdicts, in the owning session's Topic

The session bridge ([`bridge.md`](bridge.md)) also **observes** the repos its live main
sessions work in and reports one thing the forge cannot: a push to a branch, told to the
live session working on that branch. It never triggers anything. Issues, comments and
general repo activity are read on the forge itself (GitHub/Gitea notifications); the
bridge does not mirror them. Code: `scripts/bridge/observer.mjs`.

## What is observed

- **Which repos**: every repo a live main session on this machine has checked out (from
  the session's cwd, `git rev-parse --show-toplevel`). Nothing is configured per repo.
- **How often**: every `bridge.observeIntervalSeconds` (default 60, `0` = off;
  `BRIDGE_DEFAULTS` in `scripts/bridge/context.mjs`).
- **Git**: `git fetch --quiet --prune origin` (remote-tracking refs only, never the
  working tree); a repo whose `index.lock` is held is skipped for that poll. Tips are
  compared with the last seen ones, cached in `~/.claude/bridge/observer.json`. The first
  sight of a repo only records its tips: history is never reported.
- **Verdicts**: through the repo's own `python -m lab_commons.dev.forge status list <sha> --json`
  in its `.venv`. A repo without lab_commons gets the git part only.

## Where a push goes

Each machine reports only into its own sessions' Topics, whoever pushed:

- **Exactly one live main session on this machine is on that branch** -> that session's
  Topic: `pushed <shortsha> → <branch> (+N)`.
- **Several** (e.g. on `main`) -> narrowed to the pushing agent's host (`claude:` or
  `codex:`) from the committer provenance `Name (<machine>/<agent>)`.
- **None, or still ambiguous** -> dropped silently, never a guessed Topic.

A reported tip's later `lab/gate` / `lab/heavy` statuses go to the same Topic as
`lab/gate PASS <shortsha>` / `lab/heavy FAIL <shortsha>`, once each (other contexts and
pending states are ignored).

A force-pushed branch is reported with the commits new relative to its old tip.
