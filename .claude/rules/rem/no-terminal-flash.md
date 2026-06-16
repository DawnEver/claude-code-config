# No Terminal Window Flash on Windows (`windowsHide: true`)

Every `spawn` / `spawnSync` / `execFileSync` / `execSync` in this repo's hooks and background
scripts (`scripts/hooks/*`, `scripts/runtime/*`) that launches a console app — `git`, `node`,
`powershell`, `claude`, etc. — MUST pass `windowsHide: true` in its options.

**Why:** On Windows, a console-subsystem child process gets a brand-new console window
allocated whenever its parent has no console of its own. Claude Code runs hooks detached from
any console, so each unhidden spawn flashes a terminal window — very disruptive during a
session (sharp-review startup was popping ~3 windows; notify-hook popped one every event).
`windowsHide: true` suppresses the window and is a harmless no-op on macOS/Linux, so add it
unconditionally.

**Never** wrap a background launch in `cmd /c start …`. `start` spawns its own console that
`windowsHide` on the `cmd.exe` call cannot suppress. Spawn the target binary directly:
```js
spawn('powershell.exe', [...args], { detached: true, stdio: 'ignore', windowsHide: true });
```

**Exception:** foreground launchers the user invokes in their own terminal with
`stdio: 'inherit'` (`cc.js`, `todo`/`traceme` launchers) already share the user's console and
don't flash — `windowsHide` is unnecessary there (still harmless if added).

Plugin code under `cc-market/` follows the same rule — see `cc-market/.claude/rules/invariants.md`.
