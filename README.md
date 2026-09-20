# Claude Code & Codex Cross-Platform Config Sync

Syncs Claude Code and Codex configuration across devices. The working tree travels via git;
only a three-file config payload rides cloud storage (OneDrive, Dropbox, whatever you point it
at — or nothing at all, which is the zero-config default). See
[`docs/sync-architecture.md`](docs/sync-architecture.md).

> **The working tree must not live inside a cloud-synced folder.** A sync daemon replicating
> `.git/` corrupts the index and overwrites the reflog. This repo was migrated out of OneDrive
> on 2026-08-29 after exactly that.

> This repo is publicly available, but it is primarily intended for personal use and rapid iteration — backward compatibility is not a concern. Rename, restructure, or remove anything outdated rather than adding shims or compat layers.

## Prerequisites

- [Node.js](https://nodejs.org/en/download)
- [Claude Code](https://code.claude.com/docs/en/setup): `npm install -g @anthropic-ai/claude-code`
- [Codex](https://github.com/openai/codex): `npm install -g @openai/codex && codex login`

Provisioning a Windows host without admin rights? `scripts/setup/bootstrap-windows.bat`
installs Rust and Node.js LTS at user level and appends them to the user `PATH`. Run it
from an ordinary (non-elevated) shell, then open a new one so the `PATH` change takes
effect.

## Setup

```sh
npm run setup                  # create symlinks
npm run setup -- --replace     # overwrite existing files
npm test                       # unit tests
```

Creates symlinks from `~/.claude/` and `~/.codex/` to this repo. Re-run to verify - won't overwrite.
Claude links `skills/` as one directory. Codex keeps its own `~/.codex/skills`
directory for built-in `.system` skills, so setup links each repo skill from
`./skills/<name>` into `~/.codex/skills/<name>`.

If `claude_settings.json` or `claude_env_settings.json` are missing, setup copies the `.template.json` versions automatically. Fill in your API keys.

### LSPs

The `typescript-lsp`, `pyright-lsp` and `rust-analyzer-lsp` plugins ship with the official
marketplace and are **not enabled** here — they are installed but dormant, so nothing spawns
them. To turn one on, add it to `enabledPlugins` in `claude_settings.json` and install the
server:

```sh
npm install -g pyright typescript-language-server typescript
rustup component add rust-analyzer
```

**Windows:** `uv_spawn` cannot find a binary without the `.cmd` extension
([#1432](https://github.com/anthropics/claude-plugins-official/issues/1432)), so a fresh
marketplace clone needs `marketplace.json` patched. That is a one-off manual edit — the
`fix-lsp-windows.js` SessionStart hook that used to do it was removed once the plugins went
dormant, since it otherwise spawned a process on every session to patch binaries for
plugins that are never launched.

### Provider Switching

Setup installs provider wrappers alongside the host executable (CMD, PowerShell, Git Bash).
`claude_env_settings.json` is the **single source of truth** for both hosts — one
`providers.<name>` block per provider, one URL + one API key, with per-host
fields (`*ApiKeyEnv`, `*Path`) plus a single `models` map that both launchers
project from (the only thing that differs between the Anthropic and OpenAI
namespaces).

```sh
# Claude Code
ccc   # official Claude subscription
ccds  # DeepSeek  (Anthropic-compatible, direct)
cckm  # Kimi      (Anthropic-compatible, direct)
ccgmi # GMI Cloud (Anthropic-compatible, direct)

# Codex — same providers.<name> block, different launcher
cods  # DeepSeek  via codex (--config model_provider=deepseek --model deepseek-v4-flash)
```

GMI is Claude-side only. It serves the Anthropic protocol and Codex speaks only OpenAI
wire formats, so no `wire_api` value can bridge them — use `ccgmi`, not a Codex launcher.

#### Provider shape

```jsonc
{
  "providers": {
    "deepseek": {
      "url": "https://api.deepseek.com",
      "claudeApiKeyEnv": "ANTHROPIC_API_KEY",
      "claudePath":       "/anthropic",
      "codexApiKeyEnv":   "DEEPSEEK_API_KEY",
      "codexPath":        "/v1",
      "models": {
        "base":  "deepseek-v4-flash[1m]",
        "fable": "deepseek-v4-pro[1m]",
        "opus":  "deepseek-v4-flash[1m]"
      }
    }
  }
}
```

URL and the API key (from `~/.claude/claude_env_settings.local.json`) are
declared **once**. `cc.js` and `codex.js` read the same block and project to
their binary's env/args.

> A role may deliberately repeat `base` (`deepseek` sets `opus` to the same slug).
> The generated Codex catalogue is deduplicated by slug, so this provider yields
> **6 entries, not 7** — that is intended, not a generator bug.

Add a provider by adding a `providers.<name>` block and (optionally) an alias
entry in `scripts/setup/install-shell-aliases.js`. See
`docs/providers.md` for the full schema.

**Codex-side requirements:** `setup.js` generates what `cods` needs from
`providers.<name>` automatically — the `[model_providers.<id>]` block (base_url,
`env_key`, `wire_api = "responses"`) injected into `~/.codex/config.toml`, and the
schema-complete `~/.codex/models.json` model catalog (Codex 0.149 rejects the
deepseek-v4-* models without it). Both self-heal on every session (the
SessionStart/launch link check regenerates them from `providers.<name>`), so a
machine that syncs without re-running setup repairs itself; only a missing
`codex_config.toml` itself still needs `npm run setup`. See `docs/providers.md`
§ Codex side for the full shape and caveats.

#### Output styles (non-coding personas)

For non-coding work (e.g. academic writing) in the terminal, use an **output
style** rather than the default coding prompt: `output-styles/<name>.md` (synced
and symlinked to `~/.claude/output-styles`). With `keep-coding-instructions:
false` it strips Claude Code's coding guidance while keeping the harness and
tools, so you can switch between coding and writing within one session:

```
/config  → Output style → Academic   # needs /clear or a new session to take effect
```

`output-styles/academic.md` is a scholarly writing/thinking persona. Add more by
dropping a `<name>.md` file in `output-styles/`.

> A full system-prompt replacement (`--system-prompt-file`) was considered and
> rejected: it discards the entire harness and degrades Claude Code into a plain
> chatbox. See `.claude/memory/2026/06/20/persona-vs-output-style.md`.

### VS Code Extension

The VS Code extension spawns its own `claude` process. Configure it separately:

```sh
node scripts/setup/setup-vscode.js deepseek   # switch to DeepSeek
node scripts/setup/setup-vscode.js claude      # revert to official
```

Writes `terminal.integrated.env.*` and `claudeCode.environmentVariables` to local VS Code `settings.json` (and cleans up legacy `claudeCode.claudeProcessWrapper`). Re-run on each machine. Exclude these keys from VS Code Settings Sync to avoid cross-platform conflicts.

### Troubleshooting

**Windows permissions:** File symlinks need `SeCreateSymbolicLinkPrivilege` (Developer Mode, or an
elevated shell); directory entries use junctions and never need it. Without the privilege, setup
falls back to **hard links** for files and logs `(hard link)`. Hard links are two-way like symlinks,
but only while both names point at the same file record - a writer that *replaces* the file
(`git checkout`, an atomic save, a cloud sync-down) silently breaks the link. Setup reports a broken
one as `plain file, not linked`; re-run `npm run setup -- -r` to re-link. If the unlinked copy had
drifted from the repo it is kept alongside as `<name>.setup-bak` rather than discarded.

**The `claude-hud` config is always hard-linked by design** (not a Windows fallback). `claude-hud`
>= 0.8.0 refuses to load a symlinked `config.json`, so `CLAUDE_LINKS` unconditionally marks
`claude_plugins/claude-hud/config.json` as `hardlink: true`. Hard links require source and target
on the same volume (Windows: same drive letter). When they are not — a working tree on `D:` with
`~/.claude` on `C:` — setup falls back to a **copy** and says so: `claude-hud` rejects symlinks,
not copies, so the file still loads; it just stops tracking the repo until the next setup run.
An identical copy reports `ok`; a drifted one is never overwritten without `--replace`, which
keeps the old contents at `.setup-bak`.

The real config is **gitignored and per-machine** — its contents are host tuning (`lineLayout`,
`language`, `maxWidth`). The tracked file is `config.template.json`, and setup materialises the
real one from it (as does `check-links` at SessionStart, so a fresh clone heals without a full
setup run). This matters because the entry is still hard-linked: while the file was tracked, any
`git pull` that touched it replaced the inode and silently unlinked it. Nothing in git touches it
now, so the link only breaks if you edit it with a tool that replaces rather than writes the file
— and `check-links.js` repairs that on SessionStart.

### Upgrading an existing install

```sh
npm run migrate                 # one-shot: bring links + retired-plugin entries up to date
npm run migrate -- --dry-run    # preview link/settings changes without writing
```

`migrate` removes orphaned `~/.claude` / `~/.codex` symlinks whose destination is no longer in this
repo's layout, then re-runs `setup()`. It also runs any per-plugin `migrations/migrate.mjs` for
installed cc-market plugins against the current project. Re-run after any repo layout change.

`npm run setup` also auto-converts a legacy `env:<provider>` local secrets file to
`providers.<name>.apiKey` (one-time, idempotent). The pre-migration file is backed up to
`~/.claude/claude_env_settings.local.json.setup-bak` — the recovery path if the rewrite is
wrong. See `docs/providers.md` § "Migrating from the legacy `env:<provider>` shape"
for the exact shape conversion.


## Hooks

All hook scripts live in `scripts/hooks/` and are configured in `claude_settings.json`.

| Event | Script | Purpose |
|---|---|---|
| `SessionStart` | `sync-hook.js --pull` | Fast-forwards this checkout onto its upstream, so a session starts from the freshest tree. Startup only (not resume/clear/compact), silent when already current, never fatal |
| `SessionStart` | `prune-cache-hook.js` | Prunes stale plugin cache entries on session start |
| `SessionStart` | `setup-check-hook.js` | Self-heal: verifies/heals `~/.claude` symlinks via `scripts/setup/check-links.js` (recreates missing links, converts the `claude-hud` config symlink to a hard link, warns on drifted plain files) |
| `SessionStart` | `doctor.js --hook` | Reports failing invariants only (silent when healthy, ~100ms). See Health check below |
| `SessionEnd` | `sync-hook.js --remind` | Reports uncommitted files / unpushed commits in this repo. Pushing stays explicit — see `.claude/memory/2026/06/06/feedback-no-auto-push.md` |
| `Notification` | `notify-hook.js` | Native OS notification |
| `PreToolUse` (`*`) | `loop-guard-hook.js` | Anti-spin guard: hashes each `(tool, normalized input)` in a sliding window and escalates on exact repeats and near-duplicates. Warns on the 3rd identical call, denies from the 4th. Every knob is an env var — see `DEFAULTS` in the hook |
| `Stop` | `sharp-review` plugin | Wave-gated review trigger — fires `/sharp-review` once the diff crosses the wave's line/file threshold. See `docs/providers.md` |
| `statusLine` | `hud-hook.js` | Terminal HUD via [claude-hud](https://github.com/jarrodwatts/claude-hud) |

All hook scripts live in `scripts/hooks/`; `doctor.js` lives in `scripts/setup/` because it is also a setup-time command.

The `rem`, `sharp-review`, `evolve`, `traceme` and `fabric` plugins are enabled via `enabledPlugins`. That list is set on **fresh install** (the template `claude_settings.template.json` is copied to `claude_settings.json` on first run) and is otherwise a deliberate edit to the shared payload — `npm run migrate` does **not** enable plugins for you.

The REM hook gates on session depth (>= 3 stops, >= 2 min). Runs `/rem` skill. State tracked in `.claude/.rem-state.json`.

### Health check

```bash
npm run doctor          # full report; exits 1 if any invariant fails
npm run doctor -- --json
```

Every incident this repo has had is the same shape: an intended state and an actual state
diverged and nothing noticed. A hook was wired but its entry guard silently never fired; the
payload drifted from its template and a generator emitted an empty catalogue instead of an
error; a doc described hooks the config no longer wired; an invariant the design named in
prose ("no absolute path in a shared file") was enforced nowhere.

`scripts/setup/doctor.js` turns each of those into a check that fails loudly, so the class
cannot recur silently. It is read-only. Checks:

| Check | The failure it catches |
|---|---|
| Wired hooks resolve and have a live entry guard | A hook that exits 0 doing nothing — indistinguishable from "nothing to report" |
| No absolute machine path in the payload or in tracked code | A path from one host shipping to all of them |
| A host's own `byHost` entry sitting in the shared file | Reported on the host it names, with the local file to move it to — so the shared payload drains host by host instead of the cleanup living in a design note |
| Payload top-level shape vs its template | The stale-shape drift that produced an empty model catalogue |
| Link table vs what is on disk | A link entry whose source or destination has gone |
| Plugin inventory: enabled vs installed | Enabled-but-absent, and orphans whose marketplace no longer exists |
| No NUL bytes / no broken entry guards in source | A file git calls binary (unreviewable diffs, invisible to ripgrep) |

It is wired into `SessionStart` as `--hook`, which reports **failures only** and stays silent
when healthy. Warnings are informational — the dormant-plugin list is never empty — and a
notice that appears every session regardless trains the reader to ignore it.

### Syncing this repo across hosts

Tracked content (Tier A) travels by `git pull`/`push` — see `docs/sync-architecture.md`. `sync-hook.js` automates only the **inbound** half: it fast-forwards at session start, and refuses (reporting, never merging or rebasing) when the host has its own unpushed commits. The outbound half stays a deliberate user action by design.

The repo is located from the hook's own module path, so no username, drive letter, or checkout path is baked in — the same file works on every host. Every failure is a silent no-op: offline, no remote, no upstream, a held `index.lock`, or a blocked checkout all just mean "nothing changed this session". Network time is bounded by `CLAUDE_SYNC_FETCH_TIMEOUT_MS` (default 6000, settable from the `env` block of `claude_settings.json`).

Hook wiring in `claude_settings.json`:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [
      { "type": "command", "command": "node ~/.claude/scripts/hooks/sync-hook.js --pull", "timeout": 15 },
      { "type": "command", "command": "node ~/.claude/scripts/hooks/prune-cache-hook.js" },
      { "type": "command", "command": "node ~/.claude/scripts/hooks/setup-check-hook.js" }
    ] }
  ],
  "SessionEnd": [
    { "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/hooks/sync-hook.js --remind", "timeout": 10 }] }
  ],
  "Notification": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/hooks/notify-hook.js" }] }]
},
"statusLine": { "type": "command", "command": "node ~/.claude/scripts/hooks/hud-hook.js" }
```

Codex has no SessionStart hook, so `codex.js` (the launcher) runs the same link self-heal at startup — see `scripts/setup/check-links.js`.

## Notifications

`notify-hook.js` sends native notifications:

| Platform | Method | Sound | Click to open |
|---|---|---|---|
| macOS | `terminal-notifier` (Homebrew) | Built-in notification sound | Not supported (no `-open` flag) |
| Windows | PowerShell toast | Toast audio (`ms-winsoundevent:Notification.Default`) | Works out of the box |
| Linux | `notify-send` + `dbus-monitor` | `paplay` / `aplay` (freedesktop sound theme) | Requires D-Bus |

Sound is **on by default**. Pass `--no-sound` to silence it. By default, clicking the notification does **not** open VS Code. Pass `--open` to enable click-to-open:

```json
"command": "node ~/.claude/scripts/hooks/notify-hook.js --open --no-sound"
```

Test:
```sh
claude --bare --model haiku "please read ~/.claude/CLAUDE.md to test claude permission system [Expected waiting for user's input]"
```

## Memory & Rules

| Directory | Purpose | Loaded | Git |
|---|---|---|---|
| `.claude/rules/` | Distilled rule files (always-loaded) | Every session | Tracked |
| `.claude/rules/MEMORY.md` | Generated index of memory entries | Every session | **Gitignored** (device-local) |
| `.claude/memory/YYYY/MM/DD/<topic>.md` | Append-only memory archive | On demand via index | Tracked |
| `.claude/memory/YYYY/MM/DD/_meta.json` | Access metadata for the date dir | — | **Gitignored** (device-local) |

`.gitignore` uses a `**/.claude/**` pattern with `!.claude/rules/` and `!.claude/memory/` exceptions — content is git-tracked, but the per-device `MEMORY.md` indexes and `_meta.json` files are gitignored so each machine's view of the archive is independent.

After a session, add entries to `.claude/memory/YYYY/MM/DD/<topic>.md` and prepend a one-line pointer to `MEMORY.md` (newest-first). If the session changed project architecture or setup, update `AGENTS.md` too.

The `MEMORY.md` index is bounded, not capped: the injected hot set is the long-term entries plus the newest 60 short-term ones (`HOT_SHORT_MAX`), and `MAX_ENTRIES = 20` survives only as a legacy advisory value. At `CATALOG_ADVISORY_MAX` (400 entries in the full catalogue) the store is large enough that a **crystallize** is recommended — but that is a checked, user-gated step inside `/rem`, not something a hook fires. Crystallizing distills memory into `.claude/rules/`; memory files are never deleted.

## Remote Control

To enable remote control (requires Claude subscription), remove these env vars from `claude_settings.json`:

```json
"DISABLE_TELEMETRY": "1",
"DO_NOT_TRACK": "1"
```
