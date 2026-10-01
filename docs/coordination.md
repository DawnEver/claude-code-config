# Coordination view: what the lanes are doing, in Telegram

The session bridge ([`bridge.md`](bridge.md)) also **observes** the repos its live main
sessions work in and reports what moved. It never triggers anything: no merge, no run, no
reply to an issue. Origin stays the only shared medium; this is a view of it.
Code: `scripts/bridge/observer.mjs`.

## What is observed

- **Which repos**: every repo that a live main session on this machine has checked out
  (found from the session's cwd, `git rev-parse --show-toplevel`). Nothing is configured
  per repo and no path is hardcoded.
- **How often**: every `bridge.observeIntervalSeconds` (default 60, `0` = off; defaults live
  in `BRIDGE_DEFAULTS`, `scripts/bridge/context.mjs`).
- **Git**: `git fetch --quiet --prune origin`, which moves remote-tracking refs only and
  never the working tree. A repo whose `index.lock` is held is skipped for that poll. The
  remote-tracking tips are compared with the last seen ones, cached machine-locally in
  `~/.claude/bridge/observer.json`. The first sight of a repo only records its tips: history
  is never reported.
- **Statuses and issues**: through the repo's own `python -m lab_commons.dev.forge ... --json`
  (`status list <sha>`, `issue list --state open`), run with that repo's `.venv`. A repo
  without lab_commons in its venv gets the git part only; cc-config never imports lab-commons.

## Who reports a push (no duplicates across machines)

Every machine's bot sees every push, so each push is reported by exactly one machine:

- commits whose committer carries **this** machine's provenance (`Name (<machine>/<agent>)`)
  are reported by this machine;
- commits without provenance (a human's) are reported by the machine named in
  `bridge.coordinator` (shared config, e.g. `"coordinator": "G-Laptop"`);
- commits provenanced to another machine are that machine's to report.

A tip is reported once; the cache remembers it.

## Where it goes

- **A live main session on this machine is on that branch** -> that session's Topic:
  `pushed <shortsha> → <branch> (+N)`. When the tip later gets a `lab/gate` or `lab/heavy`
  status, the same Topic gets `lab/gate PASS <shortsha>` / `lab/heavy FAIL <shortsha>`, once
  each (other contexts are ignored; a pending status is not a verdict).
- **Otherwise** -> the project group's **`lanes`** Topic, which only the coordinator machine
  owns and posts to (a non-coordinator posts only into its own session Topics). `lanes` is
  an ordinary bridge Topic: it idle-closes and reopens like any other, and is never deleted
  while the daemon runs. Messages sent into it are ignored.
- **Issues** (coordinator only, repos with lab_commons): each new open issue as
  `issue #N: <title>`, and each `@<machine>` in its body as `hint: @<machine> #N <title>`.
  Comments are read too, since the last poll (`issue comments-since <ISO> --json`, the
  timestamp kept in the machine-local cache): each `@<machine>` in a new comment is posted
  once per comment id as `hint: @<machine> #N <title> — <first line>`, except when the
  comment's provenance line names that same machine (an agent mentioning itself). A
  hint is a pointer for a human, never a trigger (lab-commons `ISSUE-IS-INTENT`).

## Limits

- The coordinator cannot see other machines' sessions, so a hint is posted whether or not
  the named machine has a live session.
- A moved branch is attributed by its new commits' committers; a branch rewritten by a
  force-push is reported with the commits that are new relative to its old tip.
