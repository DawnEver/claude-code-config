# Claude Code & Codex Cross-Platform Config Sync

Syncs Claude Code and Codex configuration across devices via OneDrive.

> This repo is publicly available, but it is primarily intended for personal use and rapid iteration — backward compatibility is not a concern. Rename, restructure, or remove anything outdated rather than adding shims or compat layers.

## Prerequisites

- [Node.js](https://nodejs.org/en/download)
- [Claude Code](https://code.claude.com/docs/en/setup): `npm install -g @anthropic-ai/claude-code`
- [Codex](https://github.com/openai/codex): `npm install -g @openai/codex && codex login`

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

```sh
npm install -g pyright typescript-language-server typescript
rustup component add rust-analyzer
```

**Windows:** `setup.js` patches `marketplace.json` to append `.cmd` to LSP binary names (required by `uv_spawn` - [#1432](https://github.com/anthropics/claude-plugins-official/issues/1432)).

### Provider Switching

Setup installs provider wrappers alongside the host executable (CMD, PowerShell, Git Bash).
`claude_env_settings.json` is the **single source of truth** for both hosts — one
`providers.<name>` block per provider, one URL + one API key, with per-host
fields (`*ApiKeyEnv`, `*Path`, `*Model`, optional `claudeExtras`) for the bits
that genuinely differ between the Anthropic and OpenAI namespaces.

```sh
# Claude Code
ccc   # official Claude subscription
ccds  # DeepSeek  (Anthropic-compatible, direct)
cckm  # Kimi      (Anthropic-compatible, direct)
ccgmi # GMI Cloud (Anthropic-compatible, direct)

# Codex — same providers.<name> block, different launcher
cods  # DeepSeek  via codex (--config openai_base_url=… --model deepseek-chat)
cogmi # GMI Cloud via codex (--config openai_base_url=… --model …)
```

#### Provider shape

```jsonc
{
  "providers": {
    "deepseek": {
      "url": "https://api.deepseek.com",
      "claudeApiKeyEnv": "ANTHROPIC_API_KEY",
      "claudePath":       "/anthropic",
      "claudeModel":      "deepseek-v4-flash[1m]",
      "claudeExtras": {
        "ANTHROPIC_DEFAULT_FABLE_MODEL": "deepseek-v4-pro[1m]",
        "CLAUDE_CODE_SUBAGENT_MODEL":     "deepseek-v4-flash[1m]"
      },
      "codexApiKeyEnv":   "DEEPSEEK_API_KEY",
      "codexPath":        "/v1",
      "codexModel":       "deepseek-chat"
    }
  }
}
```

URL and the API key (from `~/.claude/claude_env_settings.local.json`) are
declared **once**. `cc.js` and `codex.js` read the same block and project to
their binary's env/args.

Add a provider by adding a `providers.<name>` block and (optionally) an alias
entry in `scripts/setup/install-shell-aliases.js`. See
`docs/providers.md` for the full schema.

**Caveat for codex-side aliases:** Two preconditions have to be true before
`cods` / `cogmi` will actually reach their provider:

1. **Missing TOML block.** You also need a `[model_providers.<id>]` block per
   provider in `~/.codex/codex_config.toml` (with `env_key` and
   `wire_api = "responses"`). Without it, codex exits with
   "model provider not found in config.toml" before the network call is even
   attempted. See `docs/providers.md` § Codex side for the full
   shape.
2. **Endpoint protocol.** DeepSeek's public OpenAI-compat endpoint is
   chat/completions, not Responses — codex needs Responses. `cods` spawns codex
   correctly with the right env/config but the network call will fail until
   either a translation proxy is fronted or DeepSeek ships a Responses endpoint.
   Same caveat applies to `cogmi` (GMI's OpenAI-compat surface is not documented).

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
(OneDrive sync-down, `git checkout`, an atomic save) silently breaks the link. Setup reports a broken
one as `plain file, not linked`; re-run `npm run setup -- -r` to re-link. If the unlinked copy had
drifted from the repo it is kept alongside as `<name>.setup-bak` rather than discarded.

**The `claude-hud` config is always hard-linked by design** (not a Windows fallback). `claude-hud`
>= 0.8.0 refuses to load a symlinked `config.json`, so `CLAUDE_LINKS` unconditionally marks
`claude_plugins/claude-hud/config.json` as `hardlink: true`. Hard links require source and target
on the same volume (Windows: same drive letter); on EXDEV the setup script logs the hint and
continues. A OneDrive sync-down that *replaces* the file rather than editing it will break the
hard link silently — re-run `npm run setup -- -r` to re-link. This is the entry most likely to need
periodic re-linking.

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
| `SessionStart` | `fix-lsp-windows.js` | Windows-only: patches LSP binary names in `marketplace.json` to append `.cmd` |
| `SessionStart` | `prune-cache-hook.js` | Prunes stale plugin cache entries on session start |
| `SessionStart` | `setup-check-hook.js` | Self-heal: verifies/heals `~/.claude` symlinks via `scripts/setup/check-links.js` (recreates missing links, converts the `claude-hud` config symlink to a hard link, warns on drifted plain files) |
| `Notification` | `notify-hook.js` | Native OS notification |
| `Stop` | `sharp-review` plugin | Post-task sharp review (3 parallel reviewers) |
| `statusLine` | `hud-hook.js` | Terminal HUD via [claude-hud](https://github.com/jarrodwatts/claude-hud) |

The `rem` and `sharp-review` plugins (Stop hooks for memory consolidation and code review) are auto-registered via `enabledPlugins` — this is set on **fresh install** (the template `claude_settings.template.json` is copied to `claude_settings.json` on first run). Existing installs pick up plugin enablement deltas via `npm run migrate`.

The REM hook gates on session depth (>= 2 stops, >= 2 min). Runs `/rem` skill. State tracked in `.claude/.rem-state.json`.

Hook wiring in `claude_settings.json`:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [
      { "type": "command", "command": "node ~/.claude/scripts/setup/fix-lsp-windows.js" },
      { "type": "command", "command": "node ~/.claude/scripts/hooks/prune-cache-hook.js" },
      { "type": "command", "command": "node ~/.claude/scripts/hooks/setup-check-hook.js" }
    ] }
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

After a session, add entries to `.claude/memory/YYYY/MM/DD/<topic>.md` and prepend a one-line pointer to `MEMORY.md` (keep >= 20 entries, newest-first). If the session changed project architecture or setup, update `AGENTS.md` too.

When `MEMORY.md` hits 20 entries, the REM hook triggers a **crystallize**: distill all memory into `.claude/rules/` rule files, then clear the index. Memory files are never deleted.

## Remote Control

To enable remote control (requires Claude subscription), remove these env vars from `claude_settings.json`:

```json
"DISABLE_TELEMETRY": "1",
"DO_NOT_TRACK": "1"
```
