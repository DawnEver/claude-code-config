---
name: Evidence-driven Telegram status cards
description: One derived editable card per session, authenticated refresh and ordered reconnect updates.
metadata:
  type: implementation
---

# Outcome

Implemented the status proposal from bridge-topic-and-status-design.md. Current
behavior is documented in docs/bridge.md Session status; that proposal remains a
historical decision snapshot, not another specification.

Adapters expose statusSnapshot and status events. Codex state derives from native
turn/pending-request data. Claude register is unknown, hook prompt/final is observed
activity, channel approval is approval-observed with explicit native-resolution gap,
and reply tool does not establish completion. No fake progress percentage or heartbeat.

Bridge edits one silent pinned card showing state/source/check time. Refresh callback
requires allowlisted sender and exact chat/Topic/message plus fresh session reference;
/status rereads without model work. Card pointer is cached transport metadata only.
Both current hosts suppress raw tool progress. Native /interrupt remains explicit;
no stale cross-turn Stop button is introduced.

Status errors cannot abort native output or backlog. Replacements wait for retiring
session writes to finish, preventing late offline edits from overwriting running.
Non-idempotent sendMessage now also refuses retry after an uncertain network result;
confirmed 429 backoff remains supported. Card pin failures do not block conversation.

## Verification

TDD native snapshots, conservative Claude state, callback authentication, one-card
updates, cached pointer reuse, failed status/backlog preservation and reconnect race.
Focused review identified the offline/replacement race; ordered drain regression passes.
Full suite 430 tests: 425 pass, zero failures, five existing cross-volume skips. Public
hygiene and diff checks pass. Live deployment evidence will be appended after restart.

## Deployment

Targeted authorized daemon restart completed; doctor reports zero failures and source
revision matches. Existing unrelated shared model/template warning remains untouched.
Machine-local Topic cache contains acknowledged status-card message pointers, proving
successful Bot API card creation after live Codex reattachment. User click/visual
acceptance is separate from fixture callback/authentication evidence; native Claude
local-resolution signal remains unsupported rather than falsely marked fixed.
