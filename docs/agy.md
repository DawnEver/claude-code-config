# Antigravity CLI (agy) as the third host

`agy` reads one global customization root, `~/.gemini/config/`. As with Codex, Claude stays the source
of truth and `agy` receives projections. Setup acts only where `~/.gemini` already exists, because
setup never creates another host's home.

## What setup puts there

| Path under `~/.gemini/config/` | How | Source |
|---|---|---|
| `GEMINI.md` | link | `GLOBAL-AGENTS.md` (the same file as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`) |
| `skills/<name>` | one link per skill | `skills/<name>` (`discoverSkillLinks()`, shared with Codex) |
| `hooks.json` | **merged** | named hook `cc-config`, which runs `scripts/hooks/agy-hook.mjs` |
| `plugins.json` | **merged** | one `entries` item for the cc-market checkout, with `include_only` set |
| `~/.gemini/antigravity-cli/settings.json` | **merged** | `statusLine` (`telemetry: true`) -> `scripts/hooks/agy-statusline.mjs`; written only when unset or already ours |

Like Codex, `agy` has no Claude channel protocol, so setup installs no `session-bridge` MCP server in
`mcp_config.json` (and cleans up any legacy managed `session-bridge` entry while preserving user MCP
servers). Outbound Telegram file attachments use the CLI `node scripts/bridge/send-attachment.mjs`,
which resolves `ANTIGRAVITY_CONVERSATION_ID` automatically.

The JSON files are real files that `agy` and the user also edit. `scripts/setup/agy-config.mjs`
rewrites only its own key and keeps every other key byte for byte. It refuses to write through a
file that is a symlink, and it refuses a file whose shape is invalid. `check-links.js`
re-merges at every session start.

Each hook command is `node "<absolute>/agy-hook.mjs" ...` with forward slashes. It never uses `~`,
because `agy` expands `~` only at the start of a command. Before a changed hook or statusLine is
written, setup runs the command exactly as `agy` does (`cmd /c` or `sh -c`, cwd = the config
dir, `{}` on stdin). It refuses to install a command that does not exit 0 with valid output
(`PreToolUse` requires a non-empty `decision`), because a failing hook blocks every tool call in
every `agy` session. Under `node --test`, both installers refuse the live `~/.gemini` paths
(a tripwire), so tests use a temporary HOME. `doctor` reports:

- `agy-native-hooks`: FAIL when the hook is missing or has drifted. WARN when the hook is
  installed but the SessionStart, PreToolUse or Stop receipt for the current definition is
  missing (`~/.gemini/config/harness-hooks/<Event>.json`).
- `agy-mcp`: FAIL if a legacy `session-bridge` entry remains in `mcp_config.json`.
- `agy-plugins`: FAIL when the managed cc-market entry is missing.

cc-market plugins: `rem`, `sharp-review`, `evolve` and `fabric` are active. The dormant
`watch`, `cc-latex` and `cc-academia` are listed with `.antigravity-plugin/plugin.json`
`"disabled": true`.

## Hooks (`agy-hook.mjs --event E`) & Trusted Project Guard Bridge

`agy` hooks run synchronously and block the loop. Slow work runs in a detached child.
Payload normalization (`stripAgyPromptEnvelope`, `AGY_TO_CLAUDE_TOOL`, `agyToCanonicalPayload`)
lives in `scripts/shared/agy-payload.mjs`.

For repositories whose `origin` matches `~/.claude/trusted-origins` (`isTrustedRepo`),
`scripts/hooks/project-guard-bridge.mjs` projects both `agy` and `codex` events onto the
repository's canonical `.claude/settings*.json` hooks (`deny-commands.js` + `deny-rules.json`
fail-closed, `dev_lab.dev.hookdispatch <Event>`) and `permissions.allow` `Bash(...)` doors —
achieving zero per-repo configuration duplication while refusing to execute hooks from untrusted
external clones.

| Event | Does | Output |
|---|---|---|
| SessionStart | Detached: `syncBeforeLaunch` + `ensureDaemon`. Inline: `checkLinks`, `doctor --hook`, plus trusted `.claude/settings.json` `SessionStart` hooks | `injectSteps` system message listing warnings/FAILs/context |
| PreToolUse `*` (timeout 660 s) | `guardCall(..., {host: 'agy'})`, then trusted project guards via `project-guard-bridge.mjs`, then the bridge (up to 600 s in Telegram-started turns), then `permissions.allow` `Bash(...)` family doors | `{decision: "deny", reason}`, bridge `{decision, reason}`, `{decision: "allow"}` for sanctioned doors, else `{decision: "ask"}` |
| PreInvocation | Delivers pending warnings and runs trusted `UserPromptSubmit` hooks (`hookdispatch UserPromptSubmit`) on the turn's first invocation. A bridge `terminate` stops the turn | `injectSteps`, or `terminationBehavior: "terminate"` with an `errorMessage` |
| PostToolUse | Runs trusted `PostToolUse` / `PostToolUseFailure` hooks (`walls` ledger) and forwards to the bridge | `{}` |
| Stop | Runs trusted `Stop` / `SubagentStop` gates (`strays`, `handback`, `scratch`, `walls`, `shellreaper`), then notification ("Antigravity - Done") and `boundedRepoReminder` (`sync-hook.js`) | `{decision: "continue", reason}` for a Stop gate block or queued Telegram input |

A loop-guard **warning** outputs `{decision: "ask"}` on PreToolUse (never empty `{}`, which `agy`
treats as a denial, and never `allow`, which would skip the user's permission prompt for non-door
commands). The warning text is stashed and injected on the next PreInvocation.

Only top-level interactive **main sessions** (`isAgyMainSession`: `is_internal !== true` in
`conversation_metadata.json`, `presence/<id>.lock` present, not in `.gemini/antigravity-cli/worktrees/`,
not `-p` print mode, and not nested inside another agent) are bridged to Telegram and the dashboard.
Subagents still run `project-guard-bridge.mjs` with `agent_id` populated so `SUBAGENT-NO-PUSH` and
other subagent-scoped deny rules enforce identically, and their token usage in `scan.mjs` attributes
to the parent conversation's workspace with `origin: 'subagent'`.

## Quota & Status Line

`agy-statusline.mjs` tees `statusLine` JSON (`telemetry: true`) to `~/.claude/bridge/agy-statusline-last.json`
and records pool windows via `teeAgyUsage`. In addition, `AccountReader` periodically refreshes
`agy -p /quota --output-format json` (`refreshAgyQuota`, zero tokens, `num_turns: 0`) so both
`gemini` and `claude-gpt` (`3p`) weekly/5h quota pools stay fresh on the dashboard even when no TUI
status line is rendering.

## Launcher `agyc`

`scripts/runtime/agy.js` (pure part: `agy-launcher.mjs`) syncs the checkout, heals links after a
pull, ensures the bridge, adds provenance (`HARNESS_MACHINE`, `HARNESS_AGENT=agy`, committer name),
and spawns `agy` through `<recorded python> -m ai_lab.session agy` (`session-launcher.mjs`), which
owns `LAB_SESSION`. Setup installs the wrapper only where `agy` is found, wherever the shell runs:
`scripts/shared/host-binary.mjs` searches the process PATH, then on Windows the registry user and
machine PATH, then the standard dir (`%LOCALAPPDATA%/agy/bin` on Windows), and names every place when it fails.
