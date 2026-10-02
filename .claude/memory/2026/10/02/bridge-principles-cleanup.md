---
name: Bridge attachment and rendering consolidation
description: Clarify one authority per concern, remove duplicated limits and correct acceptance claims.
metadata:
  type: implementation
---

# Outcome

Consolidated the existing implementation rather than adding a second service or
rewriting the bridge. Current behavior and acceptance evidence are maintained in
docs/bridge.md; historical research files are snapshots, not competing specifications.

## Decisions

- Native session owns conversation/execution; Bridge owns current routing and upload
  authorization; TelegramClient owns transport and limits; adapters project native
  inputs/outputs. Both host upload entry points converge on Bridge.sendAttachment.
- Attachment limits now have one code authority, ATTACHMENT_LIMITS in telegram.mjs.
  Cache retention is an independent resource policy, not a duplicate API limit.
- Preserve raw native answers; rich rendering is derived, not another history.
- Keep bounded machine-local attachment material. No autonomous directory scanning,
  second getUpdates consumer, external renderer or speculative compatibility layer.
- Workspace checks and opened-file identity checks protect different boundaries and
  are intentionally retained, not merged into a generic abstraction.
- Sensitive path policy checks both the selected name and resolved target; filename
  checks are not represented as content-level secret detection.

## Corrections and regression

- Added a failing regression for same-session Topic change or ended lifecycle during
  attachment download; now rejects injection and storage after either change.
- Corrected documentation: screenshot verifies prose/table/code, not math. LaTeX is
  still source text. Explicit math blocks remain a proposed test, not implemented.
- Clarified live transport/current Codex upload versus unverified phone-originated
  incoming delivery and fresh Claude native reading. Remote Control UI test waived.

## Verification

Full suite 414 tests: 409 pass, zero failures, five existing cross-volume skips.
Diff and public hygiene checks pass. Targeted authorized bridge restart deploys the
cleanup; existing Claude channel processes still require fresh native sessions for
new tool discovery. No commit/push; full historical iteration acceptance is not claimed.

## Subsequent user-directed refinement

Disabled commandExecution progress at the Codex adapter source and removed the
obsolete shell-unwrapping helper. Commands and execution output stay local; native
approval requests remain separate and retain decision context. Red-to-green tests
verify commands never become progress; full suite remains 409 passing, zero failures,
five skips.

Sent three explicit LaTeX mathematical_expression blocks (powers, integral, matrix)
in an isolated Harness Test Topic. API accepted and returned the expected block types
and exact expressions. Client visuals await screenshot confirmation; no blanket
claim of successful formula rendering is made.

## Screenshot acceptance update

The user supplied a Telegram-downloaded screenshot through the current Codex session.
It visibly renders powers, an integral/fraction and a matrix correctly. This verifies
explicit native mathematical blocks on that client and actual inbound Telegram photo
delivery into native Codex. It does not verify every client or automatic conversion:
final answers still send dollar-delimited LaTeX through Markdown without projection.
Next change should normalize math delimiters without altering code/currency or losing
surrounding Markdown; do not add an image renderer for this already-working capability.
