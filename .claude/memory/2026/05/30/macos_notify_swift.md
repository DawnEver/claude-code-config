---
name: macos-notify-swift
description: macOS notification history — Swift/NSUserNotificationCenter attempt (2026-05-30) abandoned, reverted to terminal-notifier (ba3f978)
metadata:
  type: project
created: 2026-05-30
accessed: 2026-06-10
tier: long
---

macOS notification APIs have churned repeatedly in this repo. As of `ba3f978`, **`scripts/hooks/notify-hook.js` uses `terminal-notifier` again** — if notifications break on a new macOS version, check `terminal-notifier` install/version first before reintroducing custom Swift/AppleScript/JXA paths below; none of them worked reliably.

## History (2026-05-30 — Swift/NSUserNotificationCenter, since reverted)

macOS 26.5 broke all then-existing notification paths:
- terminal-notifier 2.0.0: hung (unbundled binary, dyld issues)
- AppleScript `display notification`: XPC error (StandardAdditions.osax broken)
- JXA `displayNotification`: "Message not understood"
- UNUserNotificationCenter (new API): requires app bundle, crashes from CLI

Workaround at the time: NSUserNotificationCenter (deprecated since macOS 10.14) via a compiled Swift binary at `scripts/runtime/claude-notify` (`scripts/runtime/notify.swift`, compiled by `setup.js`'s `compileNotifyBinary()`). This API turned out to be effectively dead and was abandoned in favor of `terminal-notifier` (`ba3f978`).

## Sharp review findings from the Swift attempt (status unknown post-revert)

Parallel Codex+DeepSeek review of the Swift approach found (HIGH, both reviewers agreed):
1. Notification failures silently swallowed (`catch {}`) — no fallback/warning
2. `-open` flag in `notify.swift` was dead code (parsed, never consumed)
3. `compileNotifyBinary()` failure didn't increment setup.js's error count

These may no longer be relevant now that `terminal-notifier` is back, but #1 (don't silently swallow notification failures) is a general lesson worth re-checking in the current implementation.
