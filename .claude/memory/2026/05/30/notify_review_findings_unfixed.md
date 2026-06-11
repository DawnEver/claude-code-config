---
name: macos-notify-sharp-review-findings
description: Unfixed sharp review findings from parallel Codex+DeepSeek review of macos-26-notify-fix
metadata:
  type: project
---

Parallel sharp review (Codex adversarial-review + DeepSeek takeover) found these issues. None were fixed before session end.

**HIGH (both reviewers agree):**
1. macOS notification failures silently swallowed (`catch {}` in notify-hook.js:39-41) — no fallback, no console warning
2. `-open` flag in notify.swift is dead code — parsed, stored in userInfo, never consumed
3. `compileNotifyBinary()` failure does not increment error count in setup.js

**MEDIUM:**
4. `Thread.sleep(0.3)` unreliable — should use `RunLoop.main.run(until:)` or delegate callback
5. No `swiftc` availability check before compilation
6. Click-to-open lost on macOS (was `getVscodeUri → -open`, now impossible with NSUserNotificationCenter)
7. README still says `brew install terminal-notifier` and describes AppleScript fallback
8. `execSync` uses string interpolation for swiftc — should be `execFileSync` with array args
9. Gitignore stale binary reuse: if compile fails, existing ignored binary is reused and called "OK"

**LOW:**
10. `#!/usr/bin/env swift` shebang misleading (file is AOT-compiled, not run-as-script)
11. `link.isExtension` dead code in setup.js (no entry in CLAUDE_LINKS has this property)
12. `removeExisting` control flow confusing
13. setup.js/README.md CRLF conversion — diff noise

**Why:** These were found by two independent reviewers and cross-checked. Overlapping findings are high-confidence.

**How to apply:** Fix HIGH items before merging. See [[macos-notify-swift]] for the architectural context.
