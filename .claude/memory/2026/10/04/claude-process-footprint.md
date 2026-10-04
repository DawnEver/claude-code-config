---
name: claude-process-footprint
description: Why many claude.exe processes run on Windows and what is safe to kill
---
# Claude process footprint (Windows)

Each interactive `ccc` session is about 500 MB: claude.exe plus two node MCP children
(`fabric` mcp-server, `session-bridge` server.mjs). A `claude.exe daemon run --origin transient`
process hosts background sessions (FleetView agents, `--resume` continuations): each one adds a
`--bg-pty-host` process and a full session with its own MCP children. On 2026-10-04 that was
6 of the 8 claude.exe processes, about 1.2 GB; `taskkill /PID <daemon> /T /F` freed it.

`C:\Users\<user>\nodejs` is nvm's symlink to `AppData\Local\nvm\v<ver>`: the two claude.exe
paths are ONE install, not a duplicate. Check `Get-Item ... | Select LinkType,Target` first.

## traceme archived (same day)

Disabled fleet-wide: `traceme@cc-market` and `TRACEME_SYNC_REMOTE` dropped from the shared
settings and template; CLI wrapper and `traceme-launcher.mjs` removed (`npm run migrate` sweeps the
orphaned wrapper); fabric `emitProviderTrace` writes only if `~/.claude/traceme` exists. Each other
host still needs `claude plugin uninstall traceme@cc-market` once (doctor WARNs on the orphan).
README was cut to a progressive-disclosure entry page; detail moved to `docs/setup.md` and
`docs/operations.md`.
