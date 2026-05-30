// notify.swift — macOS notification helper
// Compile ahead of time: swiftc -O -o claude-notify notify.swift
// Run directly:          swift notify.swift  (slower, re-parses every invocation)
//
// Uses NSUserNotificationCenter (deprecated since macOS 10.14) because
// UNUserNotificationCenter requires an app bundle — this runs from a CLI
// process. Both terminal-notifier and AppleScript display notification are
// broken on macOS 26+.
import Foundation

// MARK: - CLI Argument Parsing
var title = "Claude Code"
var message = ""
var enableSound = true

let args = CommandLine.arguments.dropFirst()
var i = args.startIndex
while i < args.endIndex {
    switch args[i] {
    case "-title":   i += 1; if i < args.endIndex { title = args[i] }
    case "-message": i += 1; if i < args.endIndex { message = args[i] }
    case "--no-sound": enableSound = false
    default: break
    }
    i += 1
}

// MARK: - Send notification via NSUserNotificationCenter
let center = NSUserNotificationCenter.default
let notif = NSUserNotification()
notif.title = title
notif.informativeText = message
notif.soundName = enableSound ? NSUserNotificationDefaultSoundName : nil

center.deliver(notif)

// Wait for delivery — RunLoop drains the notification queue;
// Thread.sleep skips the run loop so the banner may not show.
RunLoop.main.run(until: Date().addingTimeInterval(0.5))
