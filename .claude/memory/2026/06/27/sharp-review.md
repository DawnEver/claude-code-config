---
name: sharp-review-2026-06-27
description: Sharp review findings — 13 total
metadata:
  type: project
---


## Review 2026-06-27 (session) — current branch

### Reviewer Status

### Confirmed findings


## Review 2026-06-27 (follow-up)

## Review 2026-06-27 (session) — architecture survey (架构锐评)

### Reviewer Status
- Reviewer general (undefined): OK
- Reviewer security (undefined): OK

### Confirmed findings

---

### [SR-20260627-001] [MEDIUM] skills/migrate/migrate.js — The git() helper function (line 181) calls execFileSync('git', args, {cwd, stdio:'pipe'}) without windowsHide: true. When migrate.js is invoked via Claude Code (detached from a console), this will flash a terminal window on Windows — violating the repo's no-terminal-flash invariant.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add windowsHide: true to the execFileSync options in the git() helper function.

---

### [SR-20260627-002] [MEDIUM] scripts/runtime/cc.js — Both cc.js (line 10-19) and setup-vscode.js (line 59-68) define an identical PROVIDER_KEYS array of 12+ env var names. Adding or removing a provider key requires updating both files — a maintenance hazard.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract PROVIDER_KEYS into a shared module (e.g., scripts/shared/provider-keys.js) and import it in both files.

---

### [SR-20260627-003] [MEDIUM] scripts/hooks/notify-hook.js — On Windows, a PowerShell script is written to os.tmpdir() and spawned. Cleanup (Remove-Item) runs inside the PowerShell script itself. If powershell.exe crashes or is killed before the finally block, the temp .ps1 file persists indefinitely.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a fallback cleanup in the Node.js process or clean old claude-notif-*.ps1 files from os.tmpdir().

---

### [SR-20260627-004] [MEDIUM] scripts/hooks/prune-cache-hook.js — The getLiveVersions() function calls execFileSync synchronously in a SessionStart hook with up to 5s timeout. On systems with many processes, this delays session start.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Make getLiveVersions() non-blocking or move the live-version scan to run in the background.

---

### [SR-20260627-005] [MEDIUM] scripts/setup/setup.js — setup.js at 404 lines handles symlink management, cc-market clone/update, shell alias installation, and PowerShell profile injection — four distinct concerns in one file.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Split into smaller modules: extract shell alias installation and macOS notification check into separate files, keeping setup.js as the orchestrator.

---

### [SR-20260627-006] [MEDIUM] skills/migrate/migrate.js — migrate.js at 420 lines handles orphaned link cleanup, alias cleanup, gitignore normalization (~130 lines), and cc-market project migration.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract the gitignore subsystem into a separate module (e.g., skills/migrate/gitignore-hygiene.js).

---

### [SR-20260627-007] [LOW] scripts/hooks/hud-hook.js — COLUMNS is set to (cols > 4 ? cols - 4 : 1). When process.stdout.columns is 0 (piped), COLUMNS becomes 1, causing layout issues.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a minimum sensible width or detect isTTY and skip the HUD when not in a TTY.

---

### [SR-20260627-008] [LOW] scripts/runtime/todo-launcher.mjs — Both launchers independently implement the same logic: read installed_plugins.json, find latest version by installedAt, resolve CLI path, fall back to repo source.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract the plugin-discovery logic into a shared utility (e.g., scripts/runtime/plugin-launcher.js).

---

### [SR-20260627-009] [MEDIUM] scripts/hooks/notify-hook.js — The .ps1 temp file uses a predictable name (claude-notif-{timestamp}-{pid}.ps1). A brief window exists where another process as the same user could read or modify the script before PowerShell executes it.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Use crypto.randomUUID() instead of Date.now()+process.pid for the temp filename.

---

### [SR-20260627-010] [MEDIUM] scripts/setup/setup.js — The installShellAliases() function writes wrapper scripts to the claude binary directory. If 'claude' resides in a shared/world-writable directory, the setup could overwrite other binaries unintentionally.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add an ownership/permission check on the target directory, or warn when outside the user's home directory.

---

### [SR-20260627-011] [LOW] scripts/runtime/cc.js — cc.js reads claude_env_settings.json (containing API keys) and passes them via process.env to the spawned 'claude' process. A compromised child process or one that logs its environment could leak keys.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a comment documenting that env vars are the intended transport and that claude_env_settings.json permissions should be 0600.

---

### [SR-20260627-012] [LOW] scripts/hooks/prune-cache-hook.js — The execFileSync call to powershell.exe uses -NoProfile but not -ExecutionPolicy Bypass, relying on the system's execution policy. notify-hook.js already sets Bypass for consistency.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add -ExecutionPolicy Bypass to the PowerShell arguments for consistency.

---

### [SR-20260627-013] [LOW] skills/migrate/migrate.js — promptGitignoreMode() creates a readline interface without a timeout. If stdin is a TTY but no user is present (e.g., SSH without PTY), the process could hang indefinitely.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a 30-second timeout to the readline question, defaulting to 'overwrite'.
