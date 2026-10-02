---
name: Bridge attachment implementation and acceptance
description: Both host attachment routes implemented; live Telegram roundtrips and current Codex upload verified.
metadata:
  type: implementation
---

# Outcome

Implemented explicit outbound and authenticated inbound attachments for Claude and
Codex without another polling consumer or conversation database. The user declined
additional Remote Control UI validation; no native Remote Control test is claimed.

## Live evidence

- Existing Harness Test forum verified before test sends.
- Synthetic TXT and PNG documents uploaded and downloaded with exact byte equality.
- PNG uploaded as photo and downloaded successfully; Telegram transformed its bytes.
- Production bridge restarted with matching source fingerprint.
- Current native Codex thread used the new IPC CLI to upload a synthetic workspace
  TXT to its own Topic; acknowledgement returned sent. Fixture removed afterward.
- Telegram API roundtrip is not proof of user-originated phone attachment delivery.
- Fresh Claude MCP tool discovery and native Read of an inbound image remain manual
  acceptance gates. Existing Claude channel processes were not force-restarted.

## Interfaces and boundaries

- Claude channel tool: send_attachment with absolute path, photo/document and caption.
- Codex command: scripts/bridge/send-attachment.mjs; uses CODEX_THREAD_ID and existing
  authenticated loopback IPC. Destination derives only from live session registration.
- Inbound exact Topic + allowlist authentication; private random cached paths, 20 MiB
  file bound, seven-day/100 MiB retention. Codex image uses native localImage input,
  checked against installed generated protocol schema. Claude gets a local reference.
- Outbound workspace canonical-path restriction, regular-file/size validation and
  opened-file identity checks. Sensitive filename filters are heuristic, not a secret
  scanner. Untrusted attachment contents must not become control instructions.
- Explicitly copy cached downloads into workspace before republishing.
- No uncertain-upload retries or claims of exactly-once delivery; tools report
  unconfirmed delivery and instruct checking the Topic before another attempt.

## Verification

TDD for transport, channel, routing and native Codex input. Full suite: 413 tests,
408 pass, zero failures, five existing cross-volume skips. Public hygiene and diff
check pass. Focused internal review identified pre-queue path validation and uncertain
delivery wording; validation moved inside serialization, open identity checked and
wording corrected. No commit or push.

See docs/bridge.md Attachments for usage and limits. Native session histories remain
the authority; cached files are transport material, not an alternate conversation.
