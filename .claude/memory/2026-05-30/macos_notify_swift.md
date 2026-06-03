---
name: macos-notify-swift
description: macOS 26.5 notification fix — terminal-notifier replaced with compiled Swift binary
metadata:
  type: project
created: 2026-05-30
accessed: 2026-05-30
tier: short
---

macOS 26.5 breaks all existing notification paths:
- terminal-notifier 2.0.0: hangs (unbundled binary, dyld issues)
- AppleScript `display notification`: XPC error (StandardAdditions.osax broken)
- JXA `displayNotification`: "Message not understood"
- UNUserNotificationCenter (new API): requires app bundle, crashes from CLI

The working solution: NSUserNotificationCenter (deprecated since macOS 10.14 but still functional on 26.5) via a compiled Swift binary at `scripts/runtime/claude-notify`.

**Why:** CLI tools can't get UNUserNotificationCenter without an app bundle. NSUserNotificationCenter is the only API that works from a bare process.

**How to apply:**
- Binary is gitignored — compiled by `setup.js` via `compileNotifyBinary()`
- Hook (`notify-hook.js`) resolves binary at `../runtime/claude-notify` relative to script using `fileURLToPath(new URL(...))`
- Source at `scripts/runtime/notify.swift` — 41 lines, Foundation-only
- Click-to-open (VS Code on notification click) lost — NSUserNotificationCenter delegate requires a run loop
- NSUserNotificationCenter may be removed in future macOS; need migration plan to UNUserNotificationCenter (possibly via minimal app bundle)

## Sharp review findings (unfixed)

See also: [[macos-notify-sharp-review-findings]]
