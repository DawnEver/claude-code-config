# Hooks, health check and memory

What runs on its own once setup is done. All hook scripts live in `scripts/hooks/` and are wired
in `claude_settings.json`; `doctor.js` lives in `scripts/setup/` because it is also a setup-time
command.

## Hooks

| Event | Script | Purpose |
|---|---|---|
| `SessionStart` | `sync-hook.js --pull` | Fast-forwards this checkout onto its upstream. Startup only, silent when current, never fatal |
| `SessionStart` | `prune-cache-hook.js` | Prunes stale plugin cache entries |
| `SessionStart` | `setup-check-hook.js` | Verifies/heals `~/.claude` links via `scripts/setup/check-links.js` |
| `SessionStart` | `doctor.js --hook` | Reports failing invariants only (silent when healthy) |
| `SessionEnd` | `sync-hook.js --remind` | Reports uncommitted files / unpushed commits. Pushing stays explicit |
| `Notification` | `notify-hook.js` | Native OS notification — see [`setup.md`](setup.md) § Notifications |
| `PreToolUse` (`*`) | `loop-guard-hook.js` | Anti-spin guard: warns on the 3rd identical call, denies from the 4th; near-duplicates too. Knobs are env vars — see `DEFAULTS` in the hook |
| `Stop` | `sharp-review` plugin | Fires `/sharp-review` once the diff crosses the wave's threshold |
| `statusLine` | `hud-hook.js` | Terminal HUD via [claude-hud](https://github.com/jarrodwatts/claude-hud) |

The bridge hooks (`bridge-hook.js`) are documented in [`bridge.md`](bridge.md). The REM hook
gates on session depth (>= 3 stops, >= 2 min) and runs `/rem`; state is in
`.claude/.rem-state.json`.

Codex has no SessionStart hook, so `codex.js` runs the same link self-heal at startup.

## Syncing this repo across hosts

Tracked content travels by `git pull`/`push` — see [`sync-architecture.md`](sync-architecture.md).
`sync-hook.js` automates only the **inbound** half: it fast-forwards at session start and refuses
(reporting, never merging or rebasing) when the host has its own unpushed commits. Outbound stays
a deliberate user action.

The repo is located from the hook's own module path, so no username or checkout path is baked
in. Every failure is a silent no-op (offline, no upstream, a held `index.lock`, …). Network time
is bounded by `CLAUDE_SYNC_FETCH_TIMEOUT_MS` (default 6000).

## Health check

```bash
npm run doctor          # full report; exits 1 if any invariant fails
npm run doctor -- --json
```

Every incident this repo has had is the same shape: an intended state and an actual state
diverged and nothing noticed. `scripts/setup/doctor.js` turns each into a check that fails
loudly. It is read-only.

| Check | The failure it catches |
|---|---|
| Wired hooks resolve and have a live entry guard | A hook that exits 0 doing nothing |
| No absolute machine path in the payload or tracked code | A path from one host shipping to all of them |
| Payload top-level shape vs its template | Stale-shape drift (it once produced an empty model catalogue) |
| Link table vs what is on disk | A link whose source or destination has gone |
| Plugin inventory: enabled vs installed | Enabled-but-absent, and orphaned installs |
| Live bridge source fingerprint | A running daemon older than the current bridge source (warns; never restarts it) |
| Telegram attachments / session status | Bridge capabilities — see [`bridge.md`](bridge.md) |
| No NUL bytes / no broken entry guards in source | A file git calls binary |

At SessionStart (`--hook`) it reports **failures only**: a notice shown every session trains the
reader to ignore it.

## Memory & rules

| Path | Purpose | Loaded | Git |
|---|---|---|---|
| `.claude/rules/` | Distilled rule files | Every session | Tracked |
| `.claude/rules/MEMORY.md` | Generated index of memory entries | Every session | Gitignored (device-local) |
| `.claude/memory/YYYY/MM/DD/<topic>.md` | Append-only memory archive | On demand via index | Tracked |
| `.claude/memory/YYYY/MM/DD/_meta.json` | Access metadata | — | Gitignored (device-local) |

The index is bounded, not capped: the injected hot set is the long-term entries plus the newest
60 short-term ones. At 400 catalogue entries a **crystallize** is recommended — a user-gated step
inside `/rem` that distills memory into `.claude/rules/`. Memory files are never deleted.
