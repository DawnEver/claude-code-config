---
name: bridge-not-a-plugin-yet
description: User decision — keep the Telegram bridge wired through claude_settings.json hooks while iterating fast; consider a plugin only once stable
---
# Decision (user, 2026-10-03)

While the Telegram bridge is iterating fast, its Claude side stays as it is: hooks wired in
`claude_settings.json` (the repo's single hook-wiring convention) pointing at repo scripts,
plus the `session-bridge` MCP channel registered by setup. Do NOT move it into a Claude
plugin yet. Revisit packaging hooks + channel as a plugin only after the feature set is
stable.

**Why:** a plugin adds a second hook-wiring location, a lagging plugin cache copy and new
channel-loading flags — costs that slow iteration. Editing `claude_settings.json` (sync
payload) for bridge hooks is accepted for this.
