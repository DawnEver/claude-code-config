---
name: Codex bridge routing and observability audit
description: Local prompt reaches the bridge; fallback routing and delayed agent text obscure delivery.
metadata:
  type: research
---

# Conclusion

The current local Codex thread is visible to the bridge. At 2026-10-23 14:13:05 UTC it registered thread 01a1691a-e422-7b51-8b92-25f9b65d74e4; at 14:13:07 UTC it attempted a 57-character prompt post to Topic 4170, matching the current user prompt plus its quote prefix. No corresponding send failure was observed. This is evidence of an attempted send, not independently verified Telegram receipt.

## Current state

- Effective allowed sources include cli and vscode; the current thread is a top-level vscode thread. Source filtering is not the immediate cause.
- The origin project name is claude-code-config, not the local cc-config directory name. It lacks a project-specific chat mapping and uses the configured fallback group.
- Agent-message deltas and completed items are buffered until turn/completed. Commentary is not forwarded immediately.
- Doctor passes all invariants. Adapter unit tests were run separately; see session output.
- A prior log entry at 12:38:43 UTC reports a null request dereference. The current adapter connects successfully; this historical error is not proof of the current symptom's cause.

## Gaps and recommendations

1. Add delivery observability: attempted versus acknowledged sends, returned message IDs, last error, and explicit session routing. The current post log precedes the API response.
2. Forward completed commentary promptly with item-ID deduplication rather than waiting for the whole turn. Preserve ordering and avoid duplicating it in the final aggregate.
3. Validate default sources against actual launcher behavior: defaults allow only cli although the current shared-daemon session reports vscode. This host already overrides correctly.
4. Reconnection currently establishes a fresh backlog time boundary. Turns begun before that boundary can be omitted from replay; evaluate item/turn cursors before claiming lossless recovery. Avoid blind retries of uncertain Telegram writes, which risk duplicates.
5. Presence is inferred from activity with a ten-minute release timeout, not actual TUI client ownership. Surface this limitation rather than presenting loaded threads as exact live sessions.
6. Audit shared-daemon session provenance: architecture documents launcher session IDs not reaching command environments, causing guarded commits to refuse rather than misattribute. Keep machine identity separate from thread identity.

No runtime configuration, service state, code, or Telegram messages were changed for this investigation. No destructive recovery or outbound test was attempted.

## Follow-up implementation and corrections

The subsequent user-requested repair adds read-only local rollout discovery alongside
the shared RPC adapter, explicitly labels observation-only sessions, sends completed
commentary promptly, distinguishes attempted and acknowledged Telegram writes, fixes
default source filtering and respects explicit no-daemon launches. The daemon's existing
source-reload mechanism activated the repair; no user TUI was stopped or resumed elsewhere.
An extra recently active main rollout was found, but rollout activity alone does not
establish a PID-to-thread mapping or exact window presence.

The earlier provenance concern is a launcher-environment boundary, not absence of native
Codex identity: native thread/session environment IDs exist. The historical claim that a
current downstream commit gate rejects missing LAB_SESSION was not verified against the
adjacent consumer checkout; see docs/codex-harness-audit.md for the corrected inventory.
Likewise, a plain codex executable is not necessarily embedded in current versions: actual
transport ownership determines control support. Existing independent sessions cannot be
silently converted to shared live sessions without risking parallel writers.

Full repository verification: 651 tests passed, one skipped, zero failed. The final
bridge-focused rerun also passed after the observation notice was made explicit. Doctor
and diff whitespace checks passed. Durable exactly-once delivery, custom Codex homes and
no-rollout sessions remain disclosed boundaries rather than claimed features.

## Files checked

- scripts/bridge/codex-adapter.mjs
- scripts/bridge/daemon.mjs
- scripts/bridge/context.mjs
- scripts/bridge/telegram.mjs
- scripts/runtime/codex-launcher.mjs
- docs/bridge.md
- docs/harness-architecture.md
- system-prompt/codex-base.md
- codex_config.template.toml
- Machine-local bridge logs and effective configuration (no secrets copied)
