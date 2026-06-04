# Notify Hook — Distilled

## macOS 26.5
- terminal-notifier & AppleScript broken; NSUserNotificationCenter (deprecated but functional) via compiled Swift binary at `scripts/runtime/claude-notify`
- Source: `scripts/runtime/notify.swift` (41 lines, Foundation-only)
- Binary gitignored; compiled by `setup.js` via `compileNotifyBinary()`

## Sharp review findings (2026-05-30) — audit 2026-06-04

All 13 findings resolved except #6 (platform limitation):

✅ #1-3 (HIGH): catch now logs, -open removed, errors++ on compile failure
✅ #4-5,7-9 (MEDIUM): RunLoop delegate, swiftc check, README cleaned, execFileSync, atomic compile
⚠️ #6: Click-to-open lost — NSUserNotificationCenter can't do click callbacks from CLI. Needs UNUserNotificationCenter + app bundle (future macOS migration)

→ See `.claude/memory/` for full history: macos-notify-swift, notify_review_findings_unfixed
