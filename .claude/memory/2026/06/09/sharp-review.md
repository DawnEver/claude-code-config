---
name: sharp-review-2026-06-09
description: Sharp review — notify hook migration from custom Swift binary to terminal-notifier
metadata:
  type: reference
  created: 2026-06-09
  accessed: 2026-06-09
created: 2026-06-09
accessed: 2026-06-09
tier: short
---

## Review 2026-06-09 (session) — notify hook terminal-notifier migration

### Reviewer Status
- Reviewer A (Codex, via takeover): OK
- Reviewer B (DeepSeek, via takeover): OK
- Reviewer C (Claude, native): OK

### Confirmed findings

---

### [SR-20260609-001] [HIGH] scripts/hooks/notify-hook.js — Hard-coded path '/opt/homebrew/bin/terminal-notifier' breaks on Intel Macs (Homebrew uses /usr/local/bin) and custom prefixes

- **Category:** Bug
- **Module:** notify hook
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Check both /opt/homebrew/bin and /usr/local/bin as fallbacks

On Intel Macs, Homebrew installs to /usr/local/bin. On Apple Silicon, it's /opt/homebrew/bin. Hard-coding one path silently fails notifications on the other architecture.

---

### [SR-20260609-002] [HIGH] scripts/setup/setup.js — checkMacNotify() hard-codes '/opt/homebrew/bin/terminal-notifier', giving false warnings on Intel Macs even when terminal-notifier is installed

- **Category:** Bug
- **Module:** setup
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Check both /opt/homebrew/bin and /usr/local/bin paths

---

### [SR-20260609-003] [MEDIUM] README.md — macOS 'Click to open' column in notification table describes installation requirement, not actual click behavior

- **Category:** Bug
- **Module:** docs
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** State actual click behavior: 'Not supported (terminal-notifier called without -open flag)'

---

### [SR-20260609-004] [MEDIUM] scripts/hooks/notify-hook.js — Top-of-file comment claims 'All platforms support clicking' but macOS notifications are not clickable

- **Category:** Bug
- **Module:** notify hook
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update the comment to note macOS click-to-open is unsupported

---

### [SR-20260609-005] [LOW] scripts/hooks/notify-hook.js — Deleted self-contained Swift binary in favor of external Homebrew dependency with no install-time enforcement

- **Category:** Bug
- **Module:** notify hook
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Consider auto-install via `brew install terminal-notifier` for smoother DX

The old approach compiled a bundled swift file during setup and was self-contained (only required Xcode CLI tools, common on dev machines). The new approach requires Homebrew + terminal-notifier. setup.js only warns and continues. If NSUserNotificationCenter is truly dead on macOS 26+, this switch is justified.
