# Notify Hook

macOS 26.5 breaks terminal-notifier and AppleScript. Working solution: compiled Swift binary (`scripts/runtime/claude-notify`) using NSUserNotificationCenter.

## Build
Binary gitignored — compiled by `setup.js` via `compileNotifyBinary()`. Source: `scripts/runtime/notify.swift` (41 lines, Foundation-only).

## Known issues → see `.claude/memory/` for current unfixed issues
