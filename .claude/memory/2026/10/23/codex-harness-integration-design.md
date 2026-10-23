---
name: Full non-Telegram Codex harness integration design
description: Reuse existing algorithms; adapt native hooks, identity, lifecycle, and resource ownership before enabling automation.
metadata:
  type: research
---

# Conclusion

Aim for equivalent capabilities, not a literal copy of Claude configuration. Most
business logic already exists. Hard gaps concern ownership, thread identity, concurrency,
completion semantics and observation limits rather than missing Codex hook names.
This investigation makes no implementation or runtime configuration changes.

## Source baseline

Repository implementation plus the fresh official Codex manual already fetched in this
thread, especially https://learn.chatgpt.com/docs/hooks.md and the advanced configuration
notification section. Native hooks are additive across sources, execute matching handlers
concurrently, and require trust of exact non-managed definitions. SessionStart supports
compact context restoration; UserPromptSubmit supports additionalContext. SessionEnd has
a one-second default and three-second maximum and is not simply window exit.

## Direct reuse

- Global instructions, platform prompt, config/provider composition, credential lookup,
  individual skill links, manual REM/TODO/memo, findings persistence and usage parsers
  need acceptance checks rather than another Codex implementation.
- Doctor's --hook output is already compatible; wire native SessionStart, keep healthy
  runs silent and bound the diagnostic work.
- checkLinks and startup sync git algorithms can be reused. Keep launcher bootstrap
  before repository imports; native hooks cover bypass launches but do not retroactively
  reload an already-running daemon's config/plugins.
- recall already has scoring, scopes, caching and an output budget. Its Codex early return
  is an outdated host limitation, not a current UserPromptSubmit capability gap.
- Memo freshness and rendering work. Restore compact context through SessionStart with
  source=compact, rather than inventing a queue or forcing unsupported PostCompact output.

## Thin adapters with important correctness work

- Use one native user hooks.json representation. Do not mirror all Claude settings or
  duplicate plugin hooks. Preserve user-owned entries, install idempotently, and require
  normal human trust review; never bypass it to claim acceptance. The TOML splitter ignores
  array-of-tables headers, making new inline hook arrays an unnecessary composition risk.
- A small ordered SessionStart dispatcher can sync startup only, then dynamically load
  healing and doctor. Separate handlers have no ordering guarantee. Use a real shared
  idempotency mechanism where wrapper env cannot reach the daemon.
- Loop guard's pure evaluator and JSON deny/warn shapes are reusable. Fix per-thread
  scope, concurrent read-modify-write, polling exemptions and shared configuration first.
  Native subagent hooks can carry a parent session_id; it is not a safe per-agent key.
  Hosted tools do not all traverse this hook path, so this is not a security boundary.
- Reuse OS notification senders. Codex notify receives JSON in argv, unlike the current
  stdin hook. Prefer native agent-turn-complete for Done to avoid notifying before REM
  or review Stop gates finish; use independent approval/input event adapters as needed.
- Reuse reminder git queries, but runRemind intentionally checks cc-config itself.
  A current-project reminder is a separate product decision. SessionEnd needs a single
  short wall-clock budget, no network and an observable output channel. Wrapper exit,
  turn Stop and native session end are different events.
- Reuse native identity rather than inventing another UUID or static LAB_SESSION.
  Define actual execution-thread identity versus root session lineage, then update
  consumers and tests. Downstream forge/gate behavior must be verified in its own repo.

## Harder gaps

### REM and review Stop coordination

REM's edit/waiting detection and review's summary/edit detection parse Claude transcript
shapes. Enable native Stop continuation only after normalizing minimal host facts and
checking actual completion, user waiting, interruption and stop_hook_active. A requested
REM is not proof that REM completed. Existing fork workflow assumes inherited context;
an empty worker is not equivalent. Reuse plugin algorithms and bundled shared helpers,
not runtime imports from this config repository into installed plugin caches.

### Session-scoped state and memory accounting

The project REM state has one hook session slot. Concurrent sessions can reset or clobber
it. Keep project memory/index singular, but key transient gate facts by session and use
existing shared locks for the complete transaction. Arbitrary shell file reads cannot be
fully reconstructed from command strings; prefer explicit touch in semantic memory
read/query tools and document the raw-shell observation limit.

### Hidden Claude dependency in review

The sharp-review classifier still invokes claude -p even on the Codex path, with fallback
to once if classification fails. Earlier availability wording was too broad for a pure
Codex host. Prefer deterministic diff/risk thresholds plus one review, unless a measured
need justifies model classification through the existing provider router.

### Cache pruning safety

Pruning already scans both caches, but command-line references do not reveal all plugin
versions retained by a shared daemon for lazy use. Do not add another automatic deletion
trigger before conservative retention or reliable ownership evidence, locking and upgrade
race tests. Unknown ownership means no deletion; reporting candidates is safe meanwhile.

### Multiple homes/accounts and telemetry independence

Custom CODEX_HOME support needs one resolution policy across launch, setup, hooks, caches,
credentials, daemon ownership and usage account attribution. Removing one env-strip entry
does not implement seats. Do not mix independent accounts' rate limits into one account.
Dashboard collection currently starts inside the Telegram bridge daemon, which requires
a bot token. If non-Telegram means operational independence from Telegram, make collection
independently runnable and treat Telegram as an optional transport, reusing collectors
rather than introducing another session/account registry.

### Native replacements, not literal parity

Use Codex TUI status/notifications and appropriate skills instead of porting Claude HUD,
keybindings, output styles or slash-command names literally. Permission policy requires
native Codex rules/sandbox semantics, not a naive conversion of Claude allow/deny strings.
Subscription token counts do not establish actual monetary cost; estimates must be labeled.
Worktree allocation, forge gates and official remote pairing have external owners and
require their own acceptance, not a config-sync claim of enforcement.

## Proposed sequence and acceptance

1. Define managed native hook ownership/trust and explicit coverage for supported CLI,
   shared daemon, direct launch and editor surfaces. Keep a single entry representation.
2. Enable low-risk doctor/heal, recall and compact restoration; preserve launcher pre-import sync.
3. Normalize native identities, lock transient state, adapt guard and notification transport.
4. Make REM/review lifecycle-aware and Codex-independent, then enable bounded Stop continuation.
5. Handle deletion, multi-home/accounts and optional telemetry separation only after their
   ownership decisions. Preserve native UI replacements and external repo boundaries.

Tests should cover startup/resume/fork/compact, immediate auto-compact continuation,
direct versus managed launch, two main sessions plus subagents, Stop gates simultaneously
due, missing Claude CLI, missing Fabric auth, timeout/offline/dirty trees, old cache
references and user-owned hook preservation. Installation tests must distinguish present,
trusted and actually executed; no automatic trust bypass or paid live probes were run.

## Files checked

- docs/codex-harness-audit.md; docs/harness-architecture.md
- scripts/hooks/{sync-hook,loop-guard-hook,prune-cache-hook,notify-hook}.js
- scripts/runtime/{codex.js,codex-launcher.mjs,startup-sync.mjs}
- scripts/setup/{doctor.js,check-links.js,codex-config-compose.mjs,codex-config-file.mjs}
- scripts/shared/machine.mjs; scripts/usage/scan.mjs
- scripts/bridge/{ensure.mjs,daemon.mjs,send-attachment.mjs}
- cc-market/rem/scripts/{recall.js,memo.js,inject-rules.js,rem-prep.js,lib.mjs}
- cc-market/rem/hooks/rem-hook.js; cc-market/rem/skills/rem/SKILL.md
- cc-market/shared/state.mjs; cc-market/sharp-review/hooks/sharp-review-hook.js
