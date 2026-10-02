---
name: Native math projection and Codex answer completeness
description: Explicit formula normalization and full final-item collection with live structural evidence.
metadata:
  type: implementation
---

# Outcome

Final Markdown projects dollar-delimited inline/display math to explicit Telegram math
tags. The original native answer remains unchanged. Code, escaped dollars, malformed
delimiters and ordinary currency are preserved by conservative parsing; formula HTML
characters are escaped. No renderer service or dependency added.

Codex previously replaced earlier answer items with the last one and ignored complete
turn snapshots. It now collects native final items in order, deduplicates by item ID,
excludes explicit commentary and uses complete snapshots to recover missed content.
Running-session resume and backlog reuse native content; stale turn events are ignored.

## Evidence

- TDD formula projection regression and seven native-answer completeness regressions.
- Live automatic projection sent into this Codex session's confirmed Harness Test Topic.
  Telegram returned the inline expression, display integral, heading, every before/after
  paragraph, table, unchanged code block and END marker. No content omission was observed
  in the returned message structure. Client visuals for automatic projection await user
  confirmation; earlier screenshot verified explicit native math block rendering.
- An earlier disposable Topic creation lost its acknowledgement; no blind retry or
  deletion was attempted. The successful test reused the existing confirmed Topic.
- Shell command execution/output suppression remains intact.

Source: https://core.telegram.org/bots/api#rich-message-formatting-options
Current usage/acceptance authority: docs/bridge.md. No commit/push.

## User screenshot acceptance

The user subsequently supplied the automatic-projection screenshot. Inline equation
and display integral render correctly; START, AFTER INLINE, AFTER DISPLAY, table,
unchanged `$x$` code and END are all visible. Formula conversion and this mixed-content
sample are client-verified, not only API-accepted. This does not establish that every
previously reported missing message was caused by the native last-item collector.

Full suite: 422 tests, 417 pass, zero failures, five existing cross-volume skips.
Public hygiene and diff checks pass; targeted authorized daemon restart deploys both
fixes. No claim of fleet/native Claude acceptance completion is made.
