---
name: bridge-iteration-plan
description: Minimal evidence-gated bridge iteration plan with explicit state ownership
metadata:
  type: project
---

# Bridge iteration plan

## Decision and scope

User requested a detailed plan grounded in first principles, removal of historical
baggage, Occam's razor, and a single source of truth. This is the authoritative
planning snapshot from this discussion, superseding the earlier chat roadmap where
they differ. It authorizes saving the plan, not implementation or deployment.
Research evidence lives in open-source-harness-comparison.md in this date directory;
do not duplicate its project catalog here. Task status belongs to the REM task engine,
not checkboxes maintained in this plan.

Goal: reliably observe and control the same live Claude/Codex session from local and
remote surfaces, with safe human decisions and explainable failures, on fleet hosts.
Keep the existing architecture only where current requirements justify it. Remove
obsolete routes, duplicate state, and superseded machinery when proven unnecessary;
do not preserve them merely for compatibility. Nothing is deleted during planning.

## Four design rules

1. First principles: derive changes from a reproduced failure or a concrete user
   requirement. Separate host behavior, bridge behavior, and transport uncertainty.
   Upstream features and README claims are evidence to inspect, not requirements.
2. Discard baggage: when replacing a path, remove the obsolete path and its tests/docs
   rather than retaining a parallel compatibility mode without a current consumer.
3. Occam: prefer a local fix and a focused regression test. No generic adapter framework,
   new config DSL, database, delivery queue, or mobile app without demonstrated need.
4. Single source: derive views from their owner. Caches and pending correlation metadata
   may exist only to support transport; they must not invent session or approval truth.

## Ownership contract

| Fact | Authority | Bridge/config responsibility |
| --- | --- | --- |
| Conversation, thread and turn | Native host | Observe/submit using native identities |
| Pending request and accepted decision | Native host | Authenticate, correlate, submit; wait for native evidence |
| Repository, branch, commits and verdicts | Git/forge and owning project infrastructure | Derive, never create a duplicate coordinator |
| Shared provider/config intent | Existing shared payload and tracked templates/code | Project into host format |
| Local secrets, identity, trust and host-written state | Existing machine-local files/native host | Preserve; never cloud-sync |
| Telegram message/topic identifiers and delivery attempts | Transport metadata | Minimal cache; not conversation history |
| Follow-up completion status | REM task engine | Link this plan, do not mirror status here |

Durable conversation continuity is not equivalent to preservation of a live process.
A missing acknowledgement does not prove an operation failed. UI timeout does not
prove the native request ended. Submitted does not mean accepted by the host.

## Execution contract

Each implementation round: reproduce -> failing test -> simplest fix -> full regression
-> focused review -> approved live verification -> update existing docs and task status.
Use fake hosts/Telegram for automated fault injection before interacting with production.
If a proposed change lacks a failing test or unmet requirement, stop and reassess it.
Unknown native request shapes stay native-only; never fabricate answers or approvals.

Local reversible edits/tests are permitted once implementation is requested. Shared
daemon restarts, real Telegram sends/deletions, other-host config changes, and commit/push
require explicit confirmation. Permission bypass is never a workaround or rollback.
External experiments need separate tokens, config homes, workspaces and scoped credentials.
Research and testing must not expose tokens, private paths, or sensitive prompt content.

## Iteration 0: establish the actual baseline (P0)

- Run tests and doctor; record skips, warnings and their consequences.
- Confirm executable and running daemon versions, not only files on disk.
- Consolidate capability/evidence in existing docs/bridge.md: discovery, main-session
  filtering, mirroring, input, clear/resume/fork, approval types, questions, interrupt,
  failures, restart and reconnect, separately for Claude and Codex.
- Label each capability live-verified, automated-only, unverified, or unsupported.
- Define isolated live fixtures and necessary correlation logs; add no generic tracing
  subsystem and log no full secrets or sensitive payloads.
- Gate: supported behaviors and open gaps are explicit; tests are reproducible.

## Iteration 1: approval identity and lifetime safety (P0)

Static finding to reproduce: daemon.mjs initializes nextApproval=1; callbacks encode
the counter and resolve against the current map without origin-message binding.
After restart and counter reuse, an authorized user's old button may target a new
request. This is not live-reproduced and not evidence of an allowlist bypass.

- First test old button from daemon A against a fresh pending request in daemon B.
- Cover duplicate clicks, non-allowlisted sender, wrong origin chat/topic/message,
  two sessions, local resolution, session end, disconnect, and send failure.
- Choose the smallest non-reusable identifier and origin/lifetime correlation needed.
  No persisted approval decisions. Native resolution must invalidate remote controls.
- Distinguish submission from native resolution; never invent which client won.
- Gate: invalid/stale callbacks never dispatch to a different request or session;
  valid callbacks can submit once; host evidence governs resolved status.

## Iteration 2: Claude coverage diagnosis (P1)

- Trace local dialog -> channel -> adapter -> Telegram -> native outcome for Write,
  Edit, safe Bash, deletion of disposable fixtures, WebFetch, MCP and AskUserQuestion.
- Test main and child-agent cases under explicit permission modes.
- If no native request exists, clarify mode/host behavior; do not patch the bridge.
- If the bridge loses an emitted request, fix that path.
- Only if a required request does not reach channels, evaluate a minimal hook fallback
  with one decision authority, local fallback, and explicit timeout/disconnect behavior.
- If safe relay cannot be established, document native-only handling instead.
- Gate: each gap has evidence and an owner; no competing channel/hook approvers.

## Iteration 3: Codex arbitration and reconnect (P1)

- Test local-first, remote-first, same-tick resolution, late submission, disconnect,
  reconnect, replayed pending requests, stale turn steering, and ancestry attribution.
- Read schemas from the installed native version before supporting a new request shape.
- Derive pending controls from the native server; do not maintain a second input queue
  or automatically replay uncertain input after connection loss.
- request_user_input is optional: add only for a confirmed need after arbitration is
  safe, with complete answer validation and explicit native-only fallback.
- Gate: concurrent clients cannot redirect stale actions; unsupported requests remain
  usable locally; reconnect neither revives resolved requests nor crosses sessions.

## Iteration 4: transport uncertainty and recovery (P1)

Define behavior before adding storage:
- Finals/failure alerts: no silent loss; report retry exhaustion and uncertainty.
- Progress: may coalesce; cannot be presented as complete history.
- Input: never blindly resubmit when the native outcome is unknown.
- Approval: never replay old decisions across restart.
- Topic cleanup: only act on a known, eligible session/topic identity.

Test acknowledged-response loss, retry exhaustion, partial chunk send, backlog,
restart during topic creation, manual close/delete, and failed cleanup. Existing
429/backoff handling is not a missing feature. Prefer native-history recovery.
Only add bounded durable delivery metadata if tests prove recovery otherwise cannot
meet the agreed requirement; explicitly choose duplicate-versus-loss semantics.
Do not claim exactly-once delivery from a non-transactional Telegram transport.
Gate: delivered/pending/failed/uncertain are distinguishable; recovery cannot duplicate
an approval or delete a live/rebound topic. New state has a precise owner and limit.

## Iteration 5: configuration and upgrade diagnostics (P2)

- Extend existing doctor/setup, not a parallel config manager.
- Report expected machine-local differences versus unintended managed-field drift.
- Test idempotence, local Codex state preservation, provider-field ownership, links,
  and running-old-code detection where it is practically observable.
- Add checks for observed silent divergence, not hypothetical adapter capabilities.
- Gate: doctor remains read-only; diagnostics explain impact/fix; setup preserves
  native/local authority and no second writer owns managed fields.

## Iteration 6: cross-platform/fleet acceptance (P1)

Validate Windows first, then available macOS/Linux hosts, then two machines and multiple
main sessions per host. Required cases: service start/update, single daemon, paths/links,
process identity, separate bot consumers, same-project isolation, sleep/network recovery,
secret separation, and timed topic cleanup using disposable fixtures.
Unavailable hosts remain explicitly unverified; a unit test is not a live-host result.
Gate: per-platform evidence and limitations; no cross-machine/session routing errors.

## Optional later work (P3; not committed scope)

Only after safety/recovery gates: clearer status, approval detail, safe attachments,
session picker, or isolated HAPI/mobile UX evaluation, each tied to a user need.
Do not adopt tmux/screen parsing, a second conversation database, external config
writers, or lab-commons workflow ownership to imitate upstream feature lists.
Check component licensing before code reuse; behavioral ideas should be implemented
minimally for our own protocol and verified independently.

## Delivery, dependencies and stopping criteria

Start with iterations 0 and 1. Use their evidence to refine 2/3; iteration 4 needs
stable identities/lifetimes. Diagnostics can be scoped independently. Cross-platform
checks should run when relevant changes land, with final fleet acceptance after core
work. This is a dependency roadmap, not a calendar promise or mandatory rewrite.

Each round ships one bounded concern. Report changed files, test results, live evidence,
remaining gaps, and rollback. Commit only after tests and confirmation. On regression,
revert that bounded change or disable only the new remote capability; preserve native
operation and state. Stop when the agreed invariants hold, not when every upstream
feature is copied. The plan is complete when core supported behaviors are safe,
recoverable and documented, with unsupported cases explicit; optional UX is not a gate.
