---
name: bridge-iteration-progress
description: Local bridge hardening evidence and remaining live acceptance gates
metadata:
  type: project
---

# Bridge iteration progress

Implementation requested through the active goal for bridge-iteration-plan.md.
The plan remains authoritative; this note records evidence, not a replacement scope.
Task status remains in the REM task engine. No deployment, commit or push occurred.

## Verified local changes

- daemon tests first reproduced restart-counter collision and dispatch after session end.
  Random 128-bit callback references, origin chat/topic/message binding and session-object
  binding now reject stale/wrong controls; correlations disappear on failed delivery/end.
  Consume before async submission prevents duplicate clicks; status says submitted rather
  than accepted. Last-chunk binding and resolution during held/in-flight delivery tested.
- Claude adapter/channel validate native request identity, reject duplicate/unknown,
  cross-session and disconnected verdicts, and withdraw old correlations on replacement.
  Withdrawals are session-scoped and explicitly do not claim native acceptance.
- Codex rejects stale steering instead of starting another turn. Old turn completions
  cannot erase a newer turn. Connection-scoped refs, request replay dedupe, pending-until-
  native-resolution semantics and transport-generation checks prevent stale dispatch.
  Unknown/unsubscribed/child requests remain native-only; questions were not added.
- Topic creation failure no longer leaks output into a group's general chat. Definite
  API rejection can retry on later activity; uncertain creation cannot blindly retry.
  Re-attaching sessions cannot bind to an in-flight deletion; failed retired-topic cleanup
  keeps its transport identity for retry without replacing the live session binding.
- Telegram malformed/lost acknowledgements are uncertain; failed chunks expose their
  acknowledged count. Network exception URLs/token text are not leaked to logs. Mention
  prefixes fit the message length limit. No new queue or conversation store was added.
- Running bridge source fingerprint is recorded on next startup; read-only doctor warns
  on unknown/changed live source. Fingerprint excludes secrets/config and does not prove
  the revision of separately running Claude channel processes.
- docs/bridge.md contains capability/evidence matrix, isolation procedure, ownership and
  delivery semantics. README documents the new diagnostic. No setup change was needed:
  runtime metadata is written by the daemon; existing installation still launches it.

## Verification

- Latest full npm test: 395 tests, 390 pass, 0 fail, 5 skipped.
- Five skips are cross-volume setup fixtures requiring a second writable volume.
- Public-hygiene and git diff --check passed.
- doctor: 0 failures, 2 warnings: existing intentional model/template difference and
  unknown source revision of the still-running pre-reporting bridge.
- Read-only native Codex integration handshake/list passed in full tests; this does not
  prove approvals, steering or pending-request replay during real reconnect.
- Focused independent review found held-approval resurrection, definite create recovery
  and malformed acknowledgement gaps; regression tests were added and fixes verified.
- Final sharp review used two internal read-only reviewers (diff/adversarial), both clean,
  with zero new findings. Results were merged by the plugin into sharp-review.md.

## Continuation evidence

Added a real loopback HTTP/TCP integration fixture exercising TelegramClient -> Bridge
-> ClaudeAdapter -> DaemonLink -> MCP verdict. It verifies multi-chunk approval buttons
on the final message, sender/chat/topic/message authentication, one-shot submission,
and disconnect cleanup. Telegram polling and a real Claude host are NOT part of this
fixture; it does not prove native acceptance. Independent focused review found no
blocking defect; additional origin assertions and timeout cleanup were added.
Inactive controls now say control inactive, rather than claiming a native request was
already resolved without evidence. Test red->green verified this wording invariant.
Only C: is available on this host; the five cross-volume setup skips remain unverified.
No deployment authorization has arrived. Explicit approval/environment questions were
sent through the user-input UI; external acceptance gates remain outstanding.

## Requirement audit: not complete

| Iteration | Current evidence | Required next evidence |
| --- | --- | --- |
| 0 | Automated/read-only baseline and isolated procedure documented | Running new revision after approved deployment |
| 1 | Reproduced regressions and local safety fixtures pass | Real stale-button/local-phone approval verification |
| 2 | Claude bridge-side correlation tested; no fallback added | Tool/mode main-child local dialog -> channel -> native acceptance matrix |
| 3 | Codex arbitration/transport regressions pass | Native simultaneous clients and pending replay timing |
| 4 | Fake transport failure/partial/Topic recovery tests; log uncertainty | Real lost-network/restart/sleep and disposable timed cleanup evidence |
| 5 | Source drift and existing composition/ownership tests pass | Approved restart clears unknown revision; channel revision checked separately |
| 6 | Windows process/service read-only evidence only | Windows fresh live cases, available macOS/Linux and two-host isolation |

Existing native histories are the recovery authority; missing Telegram messages are not
claimed automatically recovered. Unknown Topic creation may leave an undiscoverable
orphan; check identity before restarting or deleting anything. Native Claude local-
resolution notification has not been established; late verdict behavior remains live-
unverified. The code hardening must not be described as completion of these live gates.

## Next authorized boundary

Root asked for explicit confirmation to restart the Windows production bridge and run
isolated Telegram sends/approval/deletion tests. No reply has authorized these actions.
Need a dedicated test bot/group configuration and access to macOS/Linux fleet hosts.
Until then continue safe local review/tests where meaningful; do not silently deploy,
modify other hosts, create production Topics, or mark the full goal complete.

## Subsequent authorization and deployment update

The user subsequently approved restarting this host's bridge and isolated Telegram
tests. The targeted daemon restart completed; its reported source fingerprint now
matches the working source. Doctor's bridge-revision warning cleared; the remaining
model payload warning is unrelated. The pre-deployment full suite passed 390 tests,
with zero failures and five cross-volume skips. This does not verify separately
running Claude channel code or native approval behavior.

The existing Harness Test forum was confirmed using getChat. No new group, bot or
shared configuration is needed. Group identifiers and credentials stay machine-local.
Native live acceptance and fleet gates above remain outstanding. Rendering options
and the next client-compatibility test are recorded in bridge-rich-message-research.md.
