# Antigravity CLI (agy) as the third host

agy reads one global customization root, `~/.gemini/config/`. As with Codex, Claude stays the source
of truth and agy receives projections. Setup acts only where `~/.gemini` already exists, because
setup never creates another host's home.

## What setup puts there

| Path under `~/.gemini/config/` | How | Source |
|---|---|---|
| `GEMINI.md` | link | `GLOBAL-AGENTS.md` (the same file as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`) |
| `skills/<name>` | one link per skill | `skills/<name>` (`discoverSkillLinks()`, shared with Codex) |
| `hooks.json` | **merged** | named hook `cc-config`, which runs `scripts/hooks/agy-hook.mjs` |
| `mcp_config.json` | **merged** | `mcpServers.session-bridge` (`claude_plugins/session-bridge/server.mjs`) |
| `plugins.json` | **merged** | one `entries` item for the cc-market checkout, with `include_only` set |
| `~/.gemini/antigravity-cli/settings.json` | **merged** | `statusLine` -> `scripts/hooks/agy-statusline.mjs`; written only when unset or already ours |

The three JSON files are real files that agy and the user also edit. `scripts/setup/agy-config.mjs`
rewrites only its own key and keeps every other key byte for byte. It refuses to write through a
file that is a symlink, and it refuses a file whose shape is invalid. `check-links.js`
re-merges at every session start.

Each hook command is `node "<absolute>/agy-hook.mjs" ...` with forward slashes. It never uses `~`,
because agy expands `~` only at the start of a command. Before a changed hook or statusLine is
written, setup runs the command exactly as agy does (`cmd /c` or `sh -c`, cwd = the config
dir, `{}` on stdin). It refuses to install a command that does not exit 0 with JSON, because a
failing hook blocks every tool call in every agy session. For the same reason, `agy-hook.mjs`
answers `{}` and exits 0 on any error. Under `node --test`, both installers refuse the live
`~/.gemini` paths (a tripwire), so tests use a temporary HOME. `doctor` reports:

- `agy-native-hooks`: FAIL when the hook is missing or has drifted. WARN when the hook is
  installed but the SessionStart, PreToolUse or Stop receipt for the current definition is
  missing (`~/.gemini/config/harness-hooks/<Event>.json`).
- `agy-mcp` / `agy-plugins`: FAIL when the managed part is missing.

cc-market plugins: `rem`, `sharp-review`, `evolve` and `fabric` are listed. The dormant
`watch`, `cc-latex` and `cc-academia` are listed only once their agy manifest
(`.antigravity-plugin/plugin.json`) declares `"disabled": true`, which cc-market Phase 3
generates. Until then they are not loaded at all.

## Hooks (`agy-hook.mjs --event E`)

agy hooks run synchronously and block the loop. Slow work runs in a detached child.

| Event | Does | Output |
|---|---|---|
| SessionStart | Detached: `syncBeforeLaunch` + `ensureDaemon`. Inline: `checkLinks`, `doctor --hook` | `injectSteps` system message listing warnings/FAILs |
| PreToolUse `*` (timeout 660 s) | `guardCall(..., {host: 'agy'})`: thread = `conversationId`, `toolCall.name/args`, cosmetic args (`toolSummary`, `WaitMsBeforeAsync`) ignored. Then the bridge, which may answer for the user (up to 600 s, only in Telegram-started turns) | guard deny, else the bridge's `{decision, reason}` |
| PreInvocation | Delivers pending loop-guard warnings. A bridge `terminate` stops the turn | `injectSteps`, or `terminationBehavior: "terminate"` with an `errorMessage` |
| PostToolUse | Bridge only | `{}` |
| Stop | Notification ("Antigravity - Done"). The repo reminder runs when the agent is idle and not continuing, at most once per hour per state | `{decision: "continue", reason}` only for queued Telegram input |

A loop-guard **warning** gets no PreToolUse output. Answering `allow` would skip the user's
permission prompt. The warning is stashed instead, and the next PreInvocation injects it.

Bridge events (SessionStart, PreInvocation, PreToolUse, PostToolUse, Stop) are forwarded to
`scripts/bridge/agy-adapter.mjs` `forwardAgyHook(event, input)` once that file exists. It may return
`{injectSteps?, stopContinue?, decision?, reason?, terminate?}`. These pass through unchanged: the
adapter decides what is new, so `stopContinue` becomes a Stop `continue` even during a
continuation.

## Launcher `agyc`

`scripts/runtime/agy.js` (pure part: `agy-launcher.mjs`) syncs the checkout, heals links after a
pull, ensures the bridge, and adds provenance (`HARNESS_MACHINE`, `HARNESS_AGENT=agy`, committer
name). Arguments pass through to agy unchanged, because agy chooses its own models. It runs through
`ai_lab.session` once that module accepts `agy`. Until then it runs `agy` directly and carries
`LAB_SESSION` itself, inherited or freshly generated. Setup installs the wrapper only where `agy`
is on PATH.
