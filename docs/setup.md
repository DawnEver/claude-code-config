# Setup details

Everything past the README quick start: host identity, optional extras, troubleshooting and
upgrades. Provider configuration lives in [`providers.md`](providers.md); the cross-host layout
in [`sync-architecture.md`](sync-architecture.md).

## What setup does

Creates links from `~/.claude/` and `~/.codex/` to this repo. Re-run to verify — it won't
overwrite (`--replace` / `-r` does). Claude links `skills/` as one directory. Codex keeps its own
`~/.codex/skills` directory for built-in `.system` skills, so setup links each repo skill from
`./skills/<name>` into `~/.codex/skills/<name>`.

If `claude_settings.json` or `claude_env_settings.json` are missing, setup copies the
`.template.json` versions automatically. Fill in your API keys in
`~/.claude/claude_env_settings.local.json`.

Provisioning a Windows host without admin rights? `scripts/setup/bootstrap-windows.bat`
installs Rust and Node.js LTS at user level and appends them to the user `PATH`. Run it from an
ordinary (non-elevated) shell, then open a new one so the `PATH` change takes effect.

## Host identity (`--machine`)

`--machine <NAME>` writes `~/.claude/machine.json` (machine-local, never synced; names match
`[A-Za-z0-9-]+`, one unique name per host). With it, agent commands get
`GIT_COMMITTER_NAME="<git user.name> (<machine>/<claude|codex>)"` plus `HARNESS_MACHINE` /
`HARNESS_AGENT`; the git author and your manual commits are untouched. Claude gets them from the
`ccc`/`ccds` launchers (a `GIT_COMMITTER_NAME` you set in the shell is kept). Codex gets them
from `[shell_environment_policy.set]` in the per-host `~/.codex/config.toml` that setup composes,
so they apply however Codex was started (including the shared app-server daemon).

## Adding a host to the fleet

1. Clone this repo **outside** any synced folder; install Node, Git, and the CLIs.
2. Wait for the cloud client to finish downloading the sync dir, then
   `node scripts/setup/setup.js --sync-dir "<cloud>/Sync/cc-config" --machine <NAME>`
   (`<NAME>` unique per host; `--init-sync-dir` only on the very first host).
   This links the payload, including the shared `private-markers` denylist, and sets the
   public-hygiene pre-commit hook.
3. Fill in this host's secrets in `~/.claude/claude_env_settings.local.json` (API keys; and for
   the bridge, a bot of its own — [`bridge.md`](bridge.md) § Setup steps 2–3, 6).
   Re-run setup: with a bot token it installs the bridge service and registers the channel.
4. `npm run doctor` must report no FAIL. Its WARNs name what this host still lacks:
   `machine-name`, `private-markers-missing`, `bridge-host`.

## Upgrading an existing install

```sh
npm run migrate                 # bring links, wrappers and plugin .claude/ files up to date
npm run migrate -- --dry-run    # preview link/settings changes without writing
```

`migrate` removes orphaned `~/.claude` / `~/.codex` links whose destination is no longer in this
repo's layout and wrappers whose name was retired, then re-runs `setup()`. It also runs each
cc-market plugin's `migrations/migrate.mjs` against the current project. Re-run after any repo
layout change.

`npm run setup` also auto-converts a legacy `env:<provider>` local secrets file to
`providers.<name>.apiKey` (one-time, idempotent), backing the old file up to
`~/.claude/claude_env_settings.local.json.setup-bak`. See [`providers.md`](providers.md)
§ "Migrating from the legacy `env:<provider>` shape".

## Plugins

`rem`, `sharp-review`, `evolve` and `fabric` are enabled via `enabledPlugins`. That list is set on
**fresh install** (the template is copied to `claude_settings.json` on first run) and is
otherwise a deliberate edit to the shared payload — `npm run migrate` does not enable plugins.
`traceme` is archived: not enabled and not installed. A host that still has it installed gets a
doctor WARN; remove it with `claude plugin uninstall traceme@cc-market`.

### LSPs

The `typescript-lsp`, `pyright-lsp` and `rust-analyzer-lsp` plugins ship with the official
marketplace and are **not enabled** here. To turn one on, add it to `enabledPlugins` and install
the server:

```sh
npm install -g pyright typescript-language-server typescript
rustup component add rust-analyzer
```

**Windows:** `uv_spawn` cannot find a binary without the `.cmd` extension
([#1432](https://github.com/anthropics/claude-plugins-official/issues/1432)), so a fresh
marketplace clone needs `marketplace.json` patched by hand.

## Output styles (non-coding personas)

For non-coding work (e.g. academic writing) use an **output style**: `output-styles/<name>.md`,
linked to `~/.claude/output-styles`. With `keep-coding-instructions: false` it strips Claude
Code's coding guidance while keeping the harness and tools:

```
/config  → Output style → Academic   # needs /clear or a new session to take effect
```

A full system-prompt replacement was rejected: it discards the harness and degrades Claude Code
into a plain chatbox. See `.claude/memory/2026/06/20/persona-vs-output-style.md`.

## VS Code extension

The extension spawns its own `claude` process. Configure it separately, on each machine:

```sh
node scripts/setup/setup-vscode.js deepseek   # switch to DeepSeek
node scripts/setup/setup-vscode.js claude     # revert to official
```

It writes `terminal.integrated.env.*` and `claudeCode.environmentVariables` to local VS Code
`settings.json`. Exclude these keys from VS Code Settings Sync to avoid cross-platform conflicts.

## Notifications

`notify-hook.js` sends native notifications:

| Platform | Method | Sound | Click to open |
|---|---|---|---|
| macOS | `terminal-notifier` (Homebrew) | Built-in notification sound | Not supported |
| Windows | PowerShell toast | `ms-winsoundevent:Notification.Default` | Works out of the box |
| Linux | `notify-send` + `dbus-monitor` | `paplay` / `aplay` | Requires D-Bus |

Sound is on by default; `--no-sound` silences it. `--open` enables click-to-open VS Code:

```json
"command": "node ~/.claude/scripts/hooks/notify-hook.js --open --no-sound"
```

## Remote Control

Remote Control (requires a Claude subscription) needs these env vars removed from
`claude_settings.json`:

```json
"DISABLE_TELEMETRY": "1",
"DO_NOT_TRACK": "1"
```

## Troubleshooting

**Windows permissions.** File symlinks need `SeCreateSymbolicLinkPrivilege` (Developer Mode, or
an elevated shell); directory entries use junctions and never need it. Without the privilege,
setup falls back to **hard links** for files and logs `(hard link)`. A hard link breaks silently
when a writer *replaces* the file (`git checkout`, an atomic save, a cloud sync-down); setup then
reports `plain file, not linked` — re-run `npm run setup -- -r`. A drifted unlinked copy is kept
as `<name>.setup-bak`.

**The `claude-hud` config is always hard-linked.** `claude-hud` >= 0.8.0 refuses a symlinked
`config.json`. Hard links need source and target on the same volume; otherwise setup falls back
to a **copy** and says so. The real config is gitignored and per-machine (host tuning); the
tracked file is `config.template.json`, materialised by setup and by `check-links` at
SessionStart, which also repairs a broken link.
