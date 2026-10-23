---
name: Codex native harness implementation and local deployment
description: Native machine hooks, isolated guard/identity, REM/review lifecycle, safe updates and telemetry; local v3.1.0 release installed without pushing.
metadata:
  type: project
---

# Outcome

Implemented the non-Telegram integration plan in cc-config and cc-market. Machine hooks
are installed in the active Codex home without editing trust. User-authorized cc-market
source/release commits are 433ce59 and 590ddf5; annotated local tag v3.1.0 was created.
No push was performed. The user subsequently requested commit-all for the remaining
cc-config implementation, documentation and memory after final verification.

## Implementation

- One managed hooks.json entry per machine event preserves unrelated user handlers.
  Paths travel as encoded argv data, not shell code. Per-event observations bind the
  invoked definition, never the current whole-file hash or another event's execution.
- Startup sync runs before mutable launcher modules load. Native startup ignores
  daemon-lived boolean markers and shares a short machine lease across homes; healing
  and doctor load afterward in order. Resume/compact do not move the checkout.
- Guard state uses actual-thread identity, a locked transaction and private transient
  files. It never steals locks based on stale PID observations. Strict rollout identity
  supplies hook scope without shell env; unknown identity/IO contention fails open.
- Native lineage/thread identity is normalized; missing global Git names use effective
  author identity without changing the Git profile or author environment.
- Native completion/approval/observed input notices reuse OS senders. Windows XML is
  encoded data. Shutdown reminders have a short git-only budget and a local record.
- REM enables recall/access accounting, native compact restoration, per-session locked
  gates and explicit matching completion. Review removes implicit Claude classification
  and credits content only after successful findings persistence. Continuations are bounded.
- One CODEX_HOME resolver serves launch/setup/hooks/usage. One collector owns one explicit
  home; historical usage remains an unknown home-scoped account. Dashboard-only collection
  reuses existing adapters and registry without requiring Telegram transport.
- Automatic cache cleanup is report-only. Native plugin add unexpectedly deleted old
  code, sometimes leaving an empty version root. Prior backups restored missing files
  without replacing survivors. The preservation updater now restores after each add
  and failure; doctor checks protected file presence and reports conflicts read-only.

## Local activation

Native CLI readback confirms enabled Codex REM/sharp-review 2.1.0 and
Fabric/evolve/cc-latex 1.1.0, matching released source. Prior cached code was byte-verified
after restoration. The global Git marketplace source remains unchanged; local catalogue
selection was invocation-only. The preservation wrapper's real idempotent rerun skipped
all five already-cached targets and found no missing protected files.

Claude installed caches were not upgraded by this Codex-local operation. Mixed-host gate
parity requires updating those bundles too. No existing TUI was killed or resumed elsewhere.
Post-call restoration cannot make vendor cleanup atomic; use a closed-client maintenance
window when uninterrupted lazy-import availability is required.

## Verification and remaining boundaries

- Latest complete cc-config JS suite: 697 passed, one skipped, zero failed.
- Complete cc-market JS suite/release gate: 1088 passed, one skipped, zero failed.
- Release Ruff/pytest passed with existing Python 3.13 in an off-repository environment.
  Python 3.15 exceeded the native dependency's PyO3 support; that attempt safely rolled
  back before the supported-interpreter retry succeeded.
- Public-hygiene and whitespace checks passed. cc-market is clean with two local commits
  ahead of its stored upstream. Doctor has zero failures and a pending execution warning.

Review /hooks and verify a fresh supported session. No trust bypass, paid provider probe,
official remote pairing, external forge modification or other-machine rollout occurred.
One active collector home, bounded Stop scheduling and incomplete arbitrary-shell memory
read observability remain intentional limits. See docs/codex-harness-audit.md and
docs/operations.md for the current inventory and configuration.
