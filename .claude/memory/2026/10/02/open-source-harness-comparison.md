---
name: open-source-harness-comparison
description: Comparable open-source config and live-session bridges, with adoption priorities
metadata:
  type: research
---

# Open-source harness comparison (2026-10-02)

## Conclusion

Keep the current split: config deployment plus a host-neutral live-session bridge.
No reviewed project is a demonstrated drop-in replacement for the combination of
native Windows, Claude channels, the shared Codex daemon, fleet config, and no new
conversation authority. Borrow protocol invariants and tests before adopting services.
Priorities: approval identity/lifetime safety, delivery recovery, explicit capability
coverage, and configuration drift diagnostics. A mobile UI is a separate optional goal.

## Evidence and limits

Reviewed upstream repositories, documentation, selected implementation/test files,
and GitHub API metadata. Did not install, execute, or benchmark any external project.
README claims describe intended behavior, not independently verified reliability.
Repository push dates indicate activity, not release quality or support guarantees.
Some web raw-file requests failed; selected sources were retrieved read-only through
PowerShell HTTP requests instead. No external source code was written to this repo.

## Current system

- Configuration: git-managed code/templates; small cloud payload; local secrets;
  composed Codex config preserves local host state. Keep this ownership boundary.
- Remote control: one bot consumer per machine; host adapters; one topic per main
  session; Claude channels/hooks and native Codex app-server transport.
- Existing strengths: original session authority, native Windows service support,
  lifecycle tests, sender allowlist, opt-in approvals, Telegram backoff and 429 handling.
- Existing limits: Codex remotely answers only command/file-change approval shapes;
  request_user_input is left to the native client. Some live verification remains open.

## Closest projects

### 1. HAPI — strongest protocol/lifecycle reference

https://github.com/tiann/hapi
https://github.com/tiann/hapi/blob/main/docs/guide/codex-shared-sessions.md
https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md

Shared terminal/mobile Codex sessions, request_user_input, native request arbitration,
disconnect withdrawal and reconnect replay are documented explicitly. Selected
cli/src/codex/shared/permissions.test.ts tests cover same-tick native resolution,
late answers, validation before submission, stable reconnect identities, child trace
attribution, and unknown request types. Claude localPermissionBridge.ts also provides
a hook-based reference rather than assuming channels cover every tool/dialog.

Difference: HAPI owns a Hub with SQLite history and uses per-execution app-servers,
not this repo's machine-global shared daemon. Telegram Mini App is not ordinary
forum-topic messaging. Do not substitute its lifecycle assumptions unexamined.
Root license: AGPL-3.0; inspect individual component licenses before any code reuse.
Recommended: derive our own tests from documented behaviors; optional isolated UI trial
only if mobile rich interaction becomes a requirement.

### 2. claude-telegram-topics — closest Claude topology

https://github.com/wilfoa/claude-telegram-topics
https://github.com/wilfoa/claude-telegram-topics/blob/main/daemon.ts

MCP shim per session, long-lived bot-owning daemon, topics, parallel project instances,
atomic lifetime lock, and stale cached-daemon replacement closely match our needs.
It uses Bun/Unix socket and covers Claude only; our cross-host/Windows implementation
should not regress to that platform assumption. No root LICENSE was found in the
reviewed tree and API reported no license: source-visible is not verified permission
to copy. Learn its architecture; obtain clear licensing before copying implementation.

### 3. CCGram (alexei-led) — delivery and identity hardening reference

https://github.com/alexei-led/ccgram
https://github.com/alexei-led/ccgram/blob/main/docs/architecture.md

Uses terminal multiplexers and transcript monitoring, supports multiple agents, and
explicitly documents at-least-once delivery, backlog visibility, guarded session
identity, failed deletion retries, and uncertain creation outcomes after restart.
Native Windows is explicitly unsupported (WSL2 instead). MIT.
Recommended: adapt recovery invariants, not keystroke injection or terminal parsing.
Durable delivery cursors/outboxes need not become a new conversation authority; they
must remain derived transport metadata and never replay old approval decisions.

### 4. Official Anthropic Telegram channel — permission/security baseline

https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/telegram/server.ts

Selected source declares claude/channel/permission, authenticates senders, routes
permission_request, supports attachments, and refuses sending its own channel state.
Official implementation sends permission prompts to paired DMs rather than groups.
Its one-poller-per-plugin-process layout is not a replacement for our multiplexer.
Recommended: compare our channel protocol and audit privileged callbacks separately
from ordinary message routing. Do not assume official plugin implies all approval
types, expiry cases, or Windows process behavior are verified.

### 5. CCGram (jsayubi) — alternate Claude permission hook reference

https://github.com/jsayubi/ccgram
https://github.com/jsayubi/ccgram/blob/master/permission-hook.ts

Different project from alexei-led/ccgram. PermissionRequest blocks for a remote answer,
returns the hook decision via stdout, and falls back to local UI on timeout/failure;
question handling uses updatedInput. MIT. API push date was 2026-04-14, older than
the other principal candidates. Useful diagnostic reference, not a reason to install
a second hook authority alongside channels. First reproduce which requests the native
host actually emits and how local versus remote decisions are arbitrated.

### 6. codex-telegram-bridge — compact Codex interaction reference

https://github.com/maleon17/codex-telegram-bridge

Persistent app-server per Telegram user; active-turn steering, interrupt, compaction,
image input, files and deferred restarts. Linux/systemd oriented; owns its engines
instead of attaching to our existing shared live engine. Selected LICENSE is MIT,
although GitHub API classified it NOASSERTION. Useful for payload/UX ideas, not daemon
replacement. Never run it with our live bot token concurrently.

## Configuration and adjacent projects

- agentsync: https://github.com/spxrogers/agentsync — MIT, explicitly beta v0.1.0.
  Canonical config with adapter capability reporting, three-state reconciliation,
  secret references, dry-run, rollback, and explicit symlink handling. Highest config
  reference value: adopt meaningful drift reports and managed-key ownership tests.
  Do not run its apply against our real linked/composed files without an isolated trial.
- CC Switch: https://github.com/farion1231/cc-switch — MIT, cross-platform GUI.
  https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.1-config-files.md
  Distinguishes device settings and selectively writes provider fields. Our provider
  source and launchers already cover much of this. Parallel config writers would
  create a new source-of-truth problem. Use only with an explicit ownership migration.
- chezmoi: https://github.com/twpayne/chezmoi — general multi-machine config reference.
  https://www.chezmoi.io/user-guide/frequently-asked-questions/design/
  Useful for deterministic deployment and host-specific data, not live-session bridging.
- gaal: https://github.com/getgaal/gaal — AGPL-3.0, YAML-driven skills/MCP/content/repo
  reconciliation and diagnostics. More interesting if the supported agent set grows;
  unnecessary extra schema for the current two-host system.
- ccmux: https://github.com/epilande/ccmux — MIT, tmux session/worktree picker and hooks.
  Useful operator UX/worktree reference, not a Windows bridge replacement. Keep any
  large-project integration workflow on the lab-commons side of our boundary.
- Happy: https://github.com/slopus/happy — MIT, encrypted mobile/web relay ecosystem.
  README describes restarting the session in remote mode; do not conflate conversation
  continuity with the same live process. An alternative if encrypted mobile clients
  become more important than the current ordinary Telegram topic workflow.

## Concrete recommendations

1. Approval safety first. daemon.mjs initializes nextApproval=1 and sends ap:<counter>
   callbacks; callback handling looks up the current counter without binding to the
   originating Telegram message/topic. Static inference: after daemon restart and ID
   reuse, an authorized user's old button could resolve a different pending approval.
   Not live-reproduced and not evidence of unauthorized-sender bypass. Test with fake
   adapters before implementing boot-scoped random identities and origin binding.
2. Adapt HAPI cases: local/remote race, resolved request, reconnect, expired UI,
   unknown request shapes, main/subagent separation, and request_user_input capability.
3. Adapt CCGram cases: send succeeded but acknowledgement was lost, restart during
   topic creation, failed deletion, backlog indication, retry exhaustion. This repo
   already handles 429/backoff; that is not a missing feature.
4. Diagnose Claude permission coverage through channel event traces before adding a
   PermissionRequest hook fallback. A fallback must not create competing approvers.
5. Add explicit capability/managed-key diagnostics only for actual observed drift.
   Do not add an adapter framework or config GUI merely because upstream has one.
6. Isolated trials must use separate bot tokens, config homes, workspace roots and
   credentials; never give a candidate direct ownership of existing fleet config.

## Local files checked

- docs/harness-architecture.md
- docs/sync-architecture.md
- docs/bridge.md
- .claude/memory/2026/10/02/bridge-hardening.md
- scripts/bridge/codex-adapter.mjs
- scripts/bridge/claude-adapter.mjs (targeted search)
- scripts/bridge/daemon.mjs
- scripts/bridge/telegram.mjs
- claude_plugins/session-bridge/server.mjs (targeted search)
- scripts/setup/codex-config-compose.mjs (entry-point inventory)

No runtime/config/code changes and no commits were made for this investigation.
