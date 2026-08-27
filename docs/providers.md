# Provider Configuration

Reference doc for the `providers.<name>` schema in `claude_env_settings.json` (the
single source of truth shared by the Claude Code and Codex launchers). This content
lived under `.claude/rules/rem/` — it is reference material, not a rule loaded every
session, so it now lives here in `docs/`.

## Secrets are machine-local (`claude_env_settings.local.json`)

The shared `claude_env_settings.json` rides OneDrive, so it must NOT carry API keys. Each
machine keeps its own in `~/.claude/claude_env_settings.local.json` — a REAL per-machine dir
(setup.js only junctions specific children into the repo), so it never syncs. setup.js copies
it from `claude_env_settings.local.template.json` on first run. Shape mirrors the shared
registry; every config reader deep-merges local over shared (override wins), so the shared
file keeps base URLs / model pins and the local file keeps keys:

```json
{ "providers": { "deepseek": { "apiKey": "sk-..." },
                 "kimi":    { "apiKey": "sk-..." } } }
```

Consumers: root `scripts/shared/config.mjs` `readMergedEnvSettings()` (`cc.js`,
`codex.js`, `setup-vscode.js`) and fabric `engine/providers.mjs` `readRegistry()` +
`engine/node-config.mjs` `loadFabricConfig()` (`~/.claude/claude_env_settings.local.json`).
A machine without a local file fails with a clear "no apiKey for provider '<name>'" error
from the launcher (each host must supply its own key — see `scripts/runtime/cc-launcher.mjs`).
The same mechanism can override `fabric.token`/`fabric.tokens` per machine if you ever
want per-host node tokens.

### Migrating from the legacy `env:<provider>` shape

`setup.js` (`scripts/setup/migrate-local-env-settings.mjs`) auto-migrates the local
file in place on the first run after the refactor:

- Detects the legacy `env:<provider>` block, extracts the first string value (the API
  key), writes it as `providers.<provider>.apiKey`
- Backs up the pre-migration file to `claude_env_settings.local.json.setup-bak` (same
  convention as `linkEntry()` for drifted plain files)
- Prints `MIGR  claude_env_settings.local.json — N provider(s) converted…`
- Idempotent — subsequent runs see the new shape and do nothing

**Mixed files** (both `env:` and `providers:` blocks present) are left untouched, since
the auto-migrator can't tell which side is the source of truth. Setup prints a notice
naming the specific `env:<x>` keys still present; the user resolves by hand. The
launchers do NOT fall back to reading the legacy `env:<provider>.<*ApiKeyEnv>` slot — a
mixed file is a manual-recovery case, not a runtime path.

## VS Code: use environmentVariables, NOT claudeProcessWrapper

Use `claudeCode.environmentVariables` (array of `{name, value}`) to pass provider env vars to
the VS Code chat panel. Do NOT use `claudeCode.claudeProcessWrapper` — Claude Code validates
the binary is a native Claude Code binary; shell scripts and `.cmd` files are rejected with
"native binary not found". `environmentVariables` works identically on Windows, macOS, and Linux.

Run `node scripts/setup/setup-vscode.js deepseek` to configure; `setup-vscode.js` (no args)
to revert to official Claude. Also sets `claudeCode.disableLoginPrompt = true` for non-Claude
providers.

## Model & Effort Strategy

Use `opusplan` model + low effort as default. `opusplan` auto-switches Opus during plan mode
and Sonnet during execution. For critical plan sessions, run `/effort high` before `/plan`.

Sharp-review hook delegates to `/sharp-review` skill — the hook only handles classification
(none/once/triple) and state tracking; all review logic lives in the skill.

## Provider schema (`providers.<name>` — single source of truth)

`claude_env_settings.json` is the **single source of truth** for every provider
across both hosts (Claude Code + Codex). Each provider is declared **once** under
`providers.<name>` with the URL, API key, and the per-host details needed by each
binary:

```jsonc
{
  "providers": {
    "deepseek": {
      "url": "https://api.deepseek.com",        // declared once
      "claudeApiKeyEnv": "ANTHROPIC_API_KEY",    // claude side
      "claudePath":       "/anthropic",          //   composes url + path → ANTHROPIC_BASE_URL
      "codexApiKeyEnv":   "DEEPSEEK_API_KEY",    // codex side
      "codexPath":        "/v1",                 //   composes url + path → --config openai_base_url=…
      "models": {                                //   single source of truth for the model set
        "base":  "deepseek-v4-flash[1m]",        //     → ANTHROPIC_MODEL (+ codex --model, minus [1m])
        "fable": "deepseek-v4-pro[1m]",          //     → ANTHROPIC_DEFAULT_FABLE_MODEL
        "opus":  "deepseek-v4-flash-vision-exp[1m]"  // → ANTHROPIC_DEFAULT_OPUS_MODEL
        // optional per-class keys: sonnet / haiku / subagent / codex — else derived from base
      }
    }
  }
}
```

- `url`, the API key, and the `models` map are declared **once** per provider —
  both launchers (`cc.js`, `codex.js`) read from the same `providers.<name>`
  block. There is no `claudeModel` / `codexModel` / `claudeExtras` duplication —
  the model set lives in `models` and each host projects from it.
- Per-host fields (`*ApiKeyEnv`, `*Path`) are the only thing that differs —
  they're explicit because the Anthropic namespace and the OpenAI namespace are
  genuinely different.
- `models` is a single object keyed by Claude-class role. `base` is canonical:
  it maps to `ANTHROPIC_MODEL`, the codex `--model` (with the `[1m]` suffix
  stripped), and the default for `sonnet`/`haiku`/`subagent`. Optional role keys
  override a specific class (e.g. `fable`, `opus`, `haiku`, `subagent`); an
  explicit `codex` key overrides the derived codex model when a provider's codex
  id differs from its Claude `base`. Both launchers derive their projection, so
  the two hosts cannot drift.
- The `apiKey` value comes from the machine-local
  `~/.claude/claude_env_settings.local.json` overlay (see "Secrets are
  machine-local" above).

### Claude Code side (DeepSeek, Kimi, GMI)

DeepSeek (`ccds`), Kimi (`cckm`), and GMI (`ccgmi`) all connect through Claude
Code's native Anthropic-compatible endpoint. `cc.js` reads `providers.<name>`
and projects:

- `env[<claudeApiKeyEnv>] = apiKey`
- `env['ANTHROPIC_BASE_URL'] = <url><claudePath>`
- `env['ANTHROPIC_MODEL']    = models.base`
- `env['ANTHROPIC_DEFAULT_FABLE_MODEL']  = models.fable ?? models.base`
- `env['ANTHROPIC_DEFAULT_OPUS_MODEL']   = models.opus  ?? models.base`
- `env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = models.sonnet ?? models.base`
- `env['ANTHROPIC_DEFAULT_HAIKU_MODEL']  = models.haiku ?? models.base`
- `env['CLAUDE_CODE_SUBAGENT_MODEL']     = models.subagent ?? models.base`

All six Claude model vars project from the single `models` map — there is no
freeform `claudeExtras` bag to keep in sync.

No Foundry mode, no local proxy — `cc.js` just injects the projected env into
Claude Code. DeepSeek was migrated off Foundry mode
(`CLAUDE_CODE_USE_FOUNDRY` / `ANTHROPIC_FOUNDRY_*`) to this simpler direct
style so both providers share one config shape.

### Codex side (cods, cogmi)

`codex.js` reads the same `providers.<name>` block and projects:

- `env[<codexApiKeyEnv>] = apiKey` (the literal env-var name configured via
  `model_providers.<id>.env_key` in `codex_config.toml`)
- `args += ['--config', 'model_provider=<name>']` — selects the provider's
  `[model_providers.<name>]` block in `codex_config.toml`, which resolves its
  `base_url` + `env_key` + `wire_api = "responses"`. (An earlier design overrode
  the OPENAI provider's URL with `--config openai_base_url=...`; that hijacked
  the request to openai/chatgpt auth and the openai model list instead of using
  the provider's own auth/wire_api — see `.claude/memory/2026/08/25/…` for the
  DeepSeek setup script's rationale, which deletes any global `openai_base_url`.)
- `args += ['--model', <codex model>]` — codex has no model env var, only a
  `--model` CLI flag. The model derives from `models.codex ?? models.base`
  with the `[1m]` suffix stripped (`deepseek-v4-flash[1m]` → `deepseek-v4-flash`),
  so it tracks the same `models` source as the Claude side.
- `args += ['--config', 'model_catalog_json=<abs ~/.codex/models.json>']` — scoped
  to provider launches only (see below), so plain `codex` keeps OpenAI's built-in
  model list instead of showing the 3rd-party catalog.
- Setup generates a schema-complete `models.json` (with `base_instructions` = the
  repo's `system-prompt/codex-base.md`). Without `model_catalog_json`, codex 0.149
  queries the provider's `/v1/models` and, failing to parse it, shows the built-in
  openai list in the `--model` picker instead of the providers' models.

`model_catalog_json` is intentionally NOT written to the global `codex_config.toml`.
It is a startup-only top-level key that takes an absolute path; set globally it would
force plain `codex` (OpenAI backend) to load the 3rd-party `models.json` too, hiding
OpenAI's models in the picker. The `cods`/`cogmi` launcher passes it via `--config`
only when a provider is selected.

**Precondition the user maintains:** `codex_config.toml` must have a
`[model_providers.<id>]` block per provider (e.g. `model_providers.deepseek =
{ base_url = "...", env_key = "DEEPSEEK_API_KEY", wire_api = "responses" }`).
The launcher does NOT auto-inject this — see "Out of scope" below.

**End-to-end caveat:** DeepSeek natively supports the Responses API (`wire_api =
"responses"`), and its `deepseek-v4-*` models need a `~/.codex/models.json`
catalog (context window, reasoning levels, image input for the vision model) for
Codex to accept them. The launcher supplies the right env/config/`--model`; the
`models.json` catalog is generated by `scripts/setup/inject-codex-providers.mjs`
(see "Auto-rewriting `codex_config.toml`" below). GMI's OpenAI-compat surface is
not documented — same caveat applies to `cogmi`.

### Out of scope (follow-ups)

- **`fabric.engine.providers.mjs:readRegistry()` migration** to the new schema.
  Fabric (DawnEver/cc-market) currently reads `env:<provider>` blocks directly.
  After this change it must read `providers.<name>` and project via the same
  per-host logic. Until migrated, the `fabric` block in `claude_env_settings.json`
  continues to work (it has its own shape, untouched). Separate repo, follow-up PR.
- **Auto-rewriting `codex_config.toml` to inject `model_providers.<id>` blocks.**
  Today the user maintains that file. Future: a setup hook could detect the
  shared `providers.<name>` and write the matching TOML block, making
  `cods`/`cogmi` truly one-command.
- **Additional `codex` aliases (`co`, `cokm`)** — the foundation supports them. To
  add:
  - `co` (codex default / OpenAI): no `providers.codex` block needed; the launcher
    just spawns codex with no overrides. Register a shell alias in
    `scripts/runtime/aliases.{sh,ps1}` and a `CODEX_ALIASES` entry in
    `scripts/setup/install-shell-aliases.js`.
  - `cokm` (codex + Kimi): add a `providers.kimi` block (already present in
    `claude_env_settings.json` — the foundation has the kimi side ready, just
    needs the alias entry). Until then, only `cods` / `cogmi` are installed.
