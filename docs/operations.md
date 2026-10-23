# Hooks, health check and memory

What runs on its own once setup is done. The repository's user hook scripts live in
`scripts/hooks/` and are wired in **Claude's** `claude_settings.json`; `doctor.js` lives in
`scripts/setup/` because it is also a setup-time command. That wiring is not automatically
translated into Codex settings. Codex has its own setup-managed native `hooks.json`;
plugin hooks remain a separate, bundled integration.

## Hooks

| Event | Script | Purpose |
|---|---|---|
| `SessionStart` | `sync-hook.js --pull` | Fast-forwards this checkout onto its upstream. Startup only, silent when current, never fatal |
| `SessionStart` | `prune-cache-hook.js` | Reports stale cache candidates; automatic deletion is disabled |
| `SessionStart` | `setup-check-hook.js` | Verifies/heals `~/.claude` links via `scripts/setup/check-links.js` |
| `SessionStart` | `doctor.js --hook` | Reports failing invariants only (silent when healthy) |
| `SessionEnd` | `sync-hook.js --remind` | Reports uncommitted files / unpushed commits. Pushing stays explicit |
| `Notification` | `notify-hook.js` | Native OS notification — see [`setup.md`](setup.md) § Notifications |
| `PreToolUse` (`*`) | `loop-guard-hook.js` | Anti-spin guard: warns on the 3rd identical call, denies from the 4th; near-duplicates too. Knobs are env vars — see `DEFAULTS` in the hook |
| `Stop` | `sharp-review` plugin | Fires `/sharp-review` once the diff crosses the wave's threshold |
| `statusLine` | `hud-hook.js` | Terminal HUD via [claude-hud](https://github.com/jarrodwatts/claude-hud) |

The bridge hooks (`bridge-hook.js`) are documented in [`bridge.md`](bridge.md). The REM hook
gates on session depth (>= 3 stops, >= 2 min) and requests `/rem` on Claude; state is in
`.claude/.rem-state.json`. The updated Codex bundle requests bounded native continuation;
completion requires an explicit matching acknowledgement after successful work.

Codex supports both plugin and native machine hooks. The launcher retains its pre-import
checkpoint, while the separately installed native dispatcher supplies checks, protection,
notifications and reminders. This is explicit host-specific wiring, not wholesale
translation of Claude settings. See the [support matrix](codex-harness-audit.md).

## Syncing this repo across hosts

### Codex native machine hooks

Setup idempotently merges only reserved `cc-config:` handlers into the active Codex
home's `hooks.json`, preserving unrelated handlers (including empty user groups).
It never changes trust. Use `/hooks` to review new definitions. Do not duplicate these
entries in inline TOML: native sources accumulate rather than override one another.

`scripts/hooks/codex-hook.mjs` is the single machine-hook entry:

| Native event | Behavior |
| --- | --- |
| SessionStart startup | Shared short startup lease, sync before importing checks, then heal, protected-cache repair, doctor, report-only cache audit and optional collector ensure |
| SessionStart resume/fork | Heal/repair/check without moving the checkout; compact context belongs to REM's native hook |
| PreToolUse | Bounded shallow protected-cache recovery, then thread-scoped transactional loop guard; unknown execution identity fails open |
| PermissionRequest | Best-effort native OS notice; never answers or relaxes approval policy |
| PreToolUse input-request tools | Input-needed notice when the native tool-hook path exposes the question; never fabricates an answer |
| SessionEnd | Read-only cc-config dirty/upstream reminder under a single short budget; local last-reminder record, stderr and best-effort OS notice |

Completion notices use Codex `notify` (`agent-turn-complete`), not early Stop callbacks.
An explicit shared-head `notify` remains user-owned. Notification bodies omit prompt and
answer text; Windows XML is decoded as data, not interpolated PowerShell code.

Doctor distinguishes missing/drifted definitions and per-event execution observations.
One observed SessionStart does not certify PreToolUse, trust or successful enforcement.
Diagnostic receipts and cache reports live under the active home's `harness-hooks/`,
contain no raw hook payload, and are not another source of session truth.

Loop guard configuration can be set in shared/local `harness.loopGuard` (`warnAt`, `denyAt`,
`similarWarnAt`, `similarDenyAt`, `similarThreshold`, `windowMinutes`, `maxEntries`, `disable`,
`exempt`). Precedence is `HARNESS_LOOP_GUARD_*`, existing `CLAUDE_LOOP_GUARD_*`, merged
configuration, then defaults. This explicit file read works when daemon env is unrelated to
the launcher. Hosted tools outside native tool hooks remain outside the guard's coverage.

Optional `harness.notifications` supports `enabled`, `sound`, and `open`. Cache audits write
daily candidate reports without deleting old versions a daemon may still lazily load.

Native plugin updates need separate protection: the vendor CLI can remove old cache
contents even when it leaves a directory behind. Use the explicit preservation updater
in [setup.md](setup.md#codex-native-hooks-and-active-home). Its validated snapshot is
machine-local; doctor checks protected files, not merely version-directory existence.
Native app-server startup can remove old cache versions too. Preservation-only repair
runs before startup diagnostics and before tool dispatch, without installing, enabling,
deleting or overwriting plugins. Before-tool checks are shallow and use a one-second
checkpoint budget; budget expiry defers recovery without skipping the guard. Deep-only
losses require startup/full repair or doctor's complete check. No background repair
process is detached, and vendor cleanup still cannot be made atomic by these hooks.
Missing files are staged and exclusively published rather than copied partially into
an active cache. Lock records contain PID/token/time; doctor warns about unknown or
inactive owners but never steals a lock. Establish actual OS handle ownership before
maintenance, then quarantine only a confirmed ownerless lock reversibly. File age alone
is not proof that its writer stopped. Individual OS I/O is not hard-preemptible by the
before-tool checkpoint budget.

Codex's retired root `windows_wsl_setup_acknowledged` setting is filtered from the
machine-local composed file, not rewritten in the shared payload. Doctor fails when
the active local config still contains that ignored flag; recomposition removes it.

`CODEX_HOME` is preserved and resolved consistently for setup, launch, hooks and usage. Run
setup for an explicitly selected home before using it. One machine collector owns one home;
another home's launch warns instead of silently replacing the collector or mixing accounts.

### Startup synchronization

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
| `.claude/rules/` | Distilled rule files | Claude natively; Codex through REM startup/compact injection | Tracked |
| `.claude/rules/MEMORY.md` | Generated index of memory entries | Same rule-loading path | Gitignored (device-local) |
| `.claude/memory/YYYY/MM/DD/<topic>.md` | Append-only memory archive | On demand via index | Tracked |
| `.claude/memory/YYYY/MM/DD/_meta.json` | Access metadata | — | Gitignored (device-local) |

The index is bounded, not capped: the injected hot set is the long-term entries plus the newest
15 short-term ones. At 400 catalogue entries a **crystallize** is recommended — a user-gated step
inside `/rem` that distills memory into `.claude/rules/`. Memory files are never deleted.
