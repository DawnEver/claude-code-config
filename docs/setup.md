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
`.template.json` versions automatically. Provider keys belong in the credential store
([providers.md](providers.md)); the machine-local JSON holds non-key overrides and
transport secrets, never the cloud-synced payload.

### Codex native hooks and active home

Setup preserves unrelated entries while merging reserved machine handlers into
`hooks.json` in `CODEX_HOME` (default `~/.codex`). Review new definitions with `/hooks`;
trust is never automatically granted. Doctor reports missing/drifted definitions and
per-event execution observations separately. See [operations.md](operations.md) for
startup ordering, guard preferences, completion notices and shutdown reminders.

Select a custom `CODEX_HOME` before running setup and keep it for the intended launcher.
Hooks, prompt links, models, credentials and rollout sources resolve through that active
home. The machine collector refuses a different home while one is already running;
it does not guess other account directories or silently combine accounts.

Updating plugin source is not activation of an installed cache. REM/review changes require
the normal cc-market release/update lifecycle and a fresh trusted host session. Never
overwrite a live cached plugin version in place to make an unreleased change appear active.

After an explicitly approved local release, update through the preservation wrapper:

```sh
node scripts/setup/update-codex-plugins.mjs ./cc-market rem sharp-review fabric evolve cc-latex
```

Native `codex plugin add` can delete old cache contents even while leaving their version
directory present. The wrapper snapshots protected versions first, invokes native add
sequentially with an invocation-only local catalogue override, and restores missing files
after each call and on failure. Surviving bytes are never overwritten. Existing target
versions are skipped only after payload and native registration checks; partial or orphaned
targets fail explicitly and require deliberate reconciliation or a new release, not an
in-place reinstall. Native additions also require payload/registration readback, including
a final read without command-local marketplace overrides. Version or enablement drift
in that default context fails the update; this does not certify an already-running
client's loaded modules. Registered
disabled current targets remain disabled; upgrading a registered disabled older version
fails before any add because native add would enable it. Exclude that plugin or make a
deliberate native activation decision first. Native list does not distinguish an uninstalled
explicit disable from default uninstalled state: an explicit install follows native add's
activation semantics. Doctor detects missing protected files
and reports byte differences
without assuming that a difference proves corruption. No updater runs automatically from
setup, a hook or a launcher, and no hook-trust bypass or push is performed.
Preservation-only repair is separate from updating: native startup and before-tool hooks
can refill missing snapshot-protected files without vendor calls or activation changes.
Native startup itself can delete old versions. If preparing a new snapshot fails during
concurrent cleanup, the previous validated snapshot remains the recovery source.
Run full preservation-only recovery without invoking the native updater:

```sh
node scripts/setup/update-codex-plugins.mjs --repair
```

An occupied recovery/update lock returns `busy` with a nonzero exit; it is never stolen.
Snapshot restoration cannot make the vendor's delete/reinstall window atomic. If
uninterrupted lazy imports are required, schedule an update after old clients have closed;
the updater never kills them to manufacture that condition.

For Claude, the native updater refreshes its marketplace before resolving a plugin.
Checking out a local tag inside that cache does not select an unpublished release.
After explicit local-release/update approval, a process-scoped Git `url.<local-file-URL>.insteadOf`
rule can redirect only the cc-market GitHub URL to the released local repository while
running `claude plugin update <name>@cc-market --scope user --json`. Supply the rule
through the child environment's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and
`GIT_CONFIG_VALUE_<n>` (preserving any existing entries), never global Git config or
shared marketplace settings. Back up installed registries and old cache files first,
validate the native result and byte-check protected versions afterward. This does not
reload existing sessions or grant hook trust. Prefer a closed-client maintenance window.

With a sync dir (`--sync-dir`), each payload file has exactly **one name on disk, in the sync
dir**; `~/.claude` and `~/.codex` reach it through their links, and nothing is hard-linked into
the checkout (2026-11-08, [sync-architecture §3](sync-architecture.md)). doctor FAILs a managed
link whose target is gone (`link-broken`), naming the target.

Provisioning a Windows host without admin rights? `scripts/setup/bootstrap-windows.bat`
installs Rust and Node.js LTS at user level and appends them to the user `PATH`. Run it from an
ordinary (non-elevated) shell, then open a new one so the `PATH` change takes effect.

## Auto-mode rules: three layers

Claude Code reads `autoMode` only from user settings, managed settings and `--settings` —
never from a repo's `.claude/settings*.json`. Arrays from these scopes concatenate, so a
`--settings` fragment ADDS rows to the user's (measured with
`claude --settings <f> auto-mode config`). Each layer has one owner:

| Layer | Where | Holds |
| --- | --- | --- |
| public mechanism | `scripts/runtime/repo-automode.mjs`, called by `buildClaudeInvocation` for every `ccc` / `ccds` launch | nothing personal; the template's `autoMode` is absent, i.e. the built-in defaults |
| personal trust | `~/.claude/trusted-origins` (sync payload, optional) | one origin glob per line, `#` comments; `*` stays inside a path segment, `**` crosses: `git.example.com/my-org/*` |
| repo declaration | `<repo>/.claude/automode.json` | `{ "autoMode": { "allow": [...], "environment": [...] } }` — that key only |

At launch the repo is the git toplevel of the current directory; its `origin` is normalized to
`host/path` (no scheme, user, port or `.git`). The fragment is passed as
`--settings <fragment>` only when that key matches a trusted glob; otherwise nothing is passed
and the launcher prints one line naming why (not a repo, no fragment, no origin, untrusted
origin, a fragment with other keys, or an explicit `--settings`). Codex has no auto mode.

## Host identity (`--machine`)

`--machine <NAME>` writes `~/.claude/machine.json` (machine-local, never synced; names match
`[A-Za-z0-9-]+`, one unique name per host). With it, agent commands get
`GIT_COMMITTER_NAME="<git user.name> (<machine>/<claude|codex>)"` plus `HARNESS_MACHINE` /
`HARNESS_AGENT`; the git author and your manual commits are untouched. Claude gets them from the
`ccc`/`ccds` launchers (a `GIT_COMMITTER_NAME` you set in the shell is kept). Codex gets them
from `[shell_environment_policy.set]` in the per-host `~/.codex/config.toml` that setup composes,
so they apply however Codex was started (including the shared app-server daemon).

## Adding a host to the fleet

Everything below is per user account; nothing needs admin rights.

1. **Tools on the user PATH.** Node (e.g. via fnm: add `%APPDATA%\fnm\aliases\default`),
   Git, Claude Code (`~/.local/bin`, which is also where setup puts `ccc`/`ccds`), Codex, and
   `uv`. Set the *user* PATH (`[Environment]::SetEnvironmentVariable('Path', …, 'User')`),
   then open a new terminal — an already-running session and its `!` shell keep the old PATH.
   Setup installs `ccc`/`ccds` only when it finds `claude`, so it must be on PATH first.
2. **Clone, outside any synced folder**, this repo and its sibling ai-lab
   (`git clone https://github.com/DawnEver/ai-lab.git`), then `uv sync` in ai-lab to build
   `.venv` — its python is the provider catalogue ([`providers.md`](providers.md)).
3. **Setup.** Wait for the cloud client to finish downloading the sync dir, then
   ```sh
   node scripts/setup/setup.js --sync-dir "<cloud>/Sync/cc-config" --machine <NAME> \
     --ai-lab-python "<ai-lab>/.venv/Scripts/python.exe"
   ```
   `<NAME>` is unique per host and is what `seats[].machines` in the shared
   `claude_env_settings.json` names; `--init-sync-dir` only on the very first host.
   This links the payload (including `private-markers`), the seat dirs, and the
   public-hygiene pre-commit hook. If it WARNs that a repo copy is "detached and newer",
   compare it with the template: equal means an earlier run without `--sync-dir` seeded it —
   delete it and re-run. Plain files in `~/.claude` are re-linked with `--replace` (it keeps a
   `*.setup-bak`).
4. **Plugins.** If doctor reports `plugin-enabled-not-installed`:
   `claude plugin install <name>@cc-market` for each.
5. **Seats.** For each seat listed for this machine: `ccc --seat <alias>`, then `/login`.
6. **Provider keys.** `<ai-lab python> -m ai_lab.auth login <provider> --task session`
   (reads the key without echo; enables `ccds`/`cods`).
7. **Bridge.** A bot of its own in `~/.claude/claude_env_settings.local.json` (`bridge.botToken`),
   then re-run setup ([`bridge.md`](bridge.md) § Setup). In Telegram, add the bot to every
   project group and the fallback group as **admin with Manage Topics**; until then the
   daemon log shows `createForumTopic … chat not found`.
8. **Dashboard.** `npx wrangler login` (if OAuth fails with `request_forbidden`, sign in to
   dash.cloudflare.com in the default browser first), then `npm run dashboard -- host-token`
   ([`dashboard.md`](dashboard.md) § Setup). The daemon picks the token up within a minute,
   but the new Worker config can take ~5 minutes to reach every edge: `dashboard: push failed
   (HTTP 401)` in `~/.claude/bridge/daemon.log` in that window is expected and clears with
   `dashboard: push restored`. Only if 401 persists beyond that, run `npm run dashboard -- deploy`.
9. **Managed antivirus.** Sophos' behaviour detection (`Cleanup_3c`, source 7) can quarantine
   `scripts/setup/setup.js` right after a run — links, a HKCU Run key, PATH and child processes
   look like persistence. Symptom: `git status` shows ` D scripts/setup/setup.js` and doctor
   fails with `ERR_MODULE_NOT_FOUND`; proof: `C:\ProgramData\Sophos\…\SophosSafestore.log`.
   `git restore` it, and ask IT for an exclusion on the repo path — do not work around it.
10. **Verify.** `npm run doctor` must report no FAIL. Its WARNs name what this host still lacks:
   `machine-name`, `private-markers-missing`, `bridge-host`. Logs: `~/.claude/bridge/daemon.log`.

## Upgrading an existing install

```sh
npm run migrate                 # bring links, wrappers and plugin .claude/ files up to date
npm run migrate -- --dry-run    # preview link/settings changes without writing
```

`migrate` removes orphaned `~/.claude` / `~/.codex` links whose destination is no longer in this
repo's layout and wrappers whose name was retired, then re-runs `setup()`. It also runs each
cc-market plugin's `migrations/migrate.mjs` against the current project. Re-run after any repo
layout change.

`npm run setup` also writes `~/.claude/provider-cache.json` from ai-lab
(`--ai-lab-python <interpreter>` on a machine's first run). API keys live in the git credential
store (`python -m ai_lab.auth login <provider> --task session`). See [`providers.md`](providers.md).

## Plugins

`rem`, `sharp-review`, `evolve` and `fabric` are enabled via `enabledPlugins`. That list is set on
**fresh install** (the template is copied to `claude_settings.json` on first run) and is
otherwise a deliberate edit to the shared payload — `npm run migrate` does not enable plugins.
`traceme` is gone from the marketplace: usage statistics are the usage store (`docs/usage.md`).
A host that still has it installed gets doctor's orphaned-plugin WARN; remove it with
`claude plugin uninstall traceme@cc-market`.

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

Native notifications for Claude Code and Codex are disabled by default. To enable
them, set `harness.notifications.enabled` to `true` in
`~/.claude/claude_env_settings.json` (or its machine-local overlay).
The hooks and OS notification implementation remain installed.

`notify-hook.js` sends native notifications when enabled:

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
