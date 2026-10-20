# Provider Configuration

cc-config PROJECTS providers into the Claude Code and Codex hosts; it owns none of their facts.

| fact | single home | how a launcher gets it |
|---|---|---|
| url, per-protocol paths (`anthropic_path`, `openai_path`), the Claude-role model map, key usernames | ai-lab's `providers.toml` (packaged + the user's own rows); documented in ai-lab's README | `~/.claude/provider-cache.json`, written by setup |
| the API key | the git credential store (`python -m ai_lab.auth login <provider> --task session`) | `git credential fill` at launch |
| which env var each host reads the key from | `claude_env_settings.json` `providers.<name>` (`claudeApiKeyEnv`, `codexApiKeyEnv`) | read directly |

```jsonc
// claude_env_settings.json (sync payload) -- projection rules ONLY
{ "providers": { "deepseek": { "claudeApiKeyEnv": "ANTHROPIC_API_KEY", "codexApiKeyEnv": "DEEPSEEK_API_KEY" } } }
```

A provider is launchable when it has projection rules here AND a row in the ai-lab catalogue.
The retired fields `url`, `claudePath`, `codexPath`, `models` (shared file) and `apiKey` (local
file) are REFUSED by name at launch, each message naming the field's new home; there is no
fallback that reads them (`scripts/shared/provider-projection.mjs`).

## The provider cache (`~/.claude/provider-cache.json`)

`node scripts/setup/setup.js [--ai-lab-python <interpreter>]` runs
`<interpreter> -m ai_lab.providers --json` once and writes its document as the cache
(`scripts/shared/provider-cache.mjs`). The interpreter is the flag, else the one the previous
cache recorded; the first setup on a machine needs the flag (the ai-lab venv's python). Setup
is the only place cc-config runs Python; a launch never does.

Every launch checks the cache in Node and REFUSES to launch on any of these, naming the
remedy (rerun setup) -- there is no silent regeneration:

- absent, unparseable, or a `schema_version` other than 1;
- (a) `source_sha256` differs from a fresh sha256 over the recorded input files (the packaged
  `providers.toml`, then the user `providers.toml`; an absent file adds no bytes);
- (b) the ai-lab version in the `ai_lab-<v>.dist-info` beside the recorded interpreter differs
  from the recorded `ai_lab_version`;
- (c) `generated_at` is older than 7 days.

The cache holds no secret: a key is named by its credential USERNAME (`key_usernames`), never
carried. The codex `[model_providers.*]` blocks and `~/.codex/models.json` are generated from
the same cache by setup and the SessionStart self-heal; a stale cache leaves the last-known-good
artifacts untouched and is reported.

## Keys: the git credential store, task `session`

A launcher reads `key_usernames.session` from the catalogue row (ai-lab derives it from
lab-commons' one naming rule, `api-key-session`; Node never re-derives it) and runs
`git credential fill` for `https://<username>@<host>` with prompts off
(`scripts/shared/credential-key.mjs`). The key goes only into the env of the spawned host; it is
never written to a file and never logged. No key, no launch: the refusal names the username,
the host and the `ai_lab.auth login` command. Store a key with:

```sh
<ai-lab python> -m ai_lab.auth login deepseek --task session     # reads the key without echo
```

Note: the `session` task must be declared in lab-commons' `API_KEY_TASKS` (pending PR); until it
is, the catalogue carries no `session` username and a provider launch refuses, naming that.

### Migration of plaintext keys (one-shot, in setup)

Each `providers.<p>.apiKey` still in `~/.claude/claude_env_settings.local.json` is stored with
`<python> -m ai_lab.auth login <p> --task session` (the key on stdin, never argv; ai-lab's
duplicate-key refusal applies). The file is first backed up to
`claude_env_settings.local.json.setup-bak` (`.setup-bak.N` when one already exists), then each
stored field is deleted (`scripts/setup/provider-setup.mjs`). A key ai-lab refuses stays in the
file, setup reports it by provider name (never the key), and the launcher keeps refusing it.

## Missing tools refuse by name

| role | needs | refusal |
|---|---|---|
| setup (cache, migration) | Python + ai-lab, git | `no Python: ...`, `no ai-lab: ...` |
| launch `ccc`/`ccds`/`codc`/`cods` | Node, git, a current cache | `<name> needs Node`, `no git: ...`, the cache refusal |

## VS Code: use environmentVariables, NOT claudeProcessWrapper

Use `claudeCode.environmentVariables` (array of `{name, value}`) to pass provider env vars to
the VS Code chat panel. Do NOT use `claudeCode.claudeProcessWrapper` — Claude Code validates
the binary is a native Claude Code binary; shell scripts and `.cmd` files are rejected with
"native binary not found".

`node scripts/setup/setup-vscode.js deepseek` writes the projected base URL and models; it does
NOT write the key (VS Code's settings.json is a file, and a key lives only in the store). Give
the panel its key from the environment VS Code starts in, or run `ccds` in its terminal.
`setup-vscode.js` (no args) reverts to official Claude.

## Claude Code side (ccds)

`cc.js` projects, from the catalogue row and the rules:

- `env[<claudeApiKeyEnv>] = <key from the store>`
- `env['ANTHROPIC_BASE_URL'] = endpoints.anthropic` (a provider without the anthropic protocol is refused)
- `env['ANTHROPIC_MODEL'] = models.base`, and each of
  `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` =
  `models.<role> ?? models.base`

Claude's `/model` picker may save an optional top-level `model` preference in user settings;
startup `--model` and the projected `ANTHROPIC_MODEL` take precedence over it.

## Codex side (cods)

`codex.js` projects from the cache and the rules:

- `env[<codexApiKeyEnv>] = <key from the store>` (the literal env-var name the generated
  `model_providers.<id>.env_key` names)
- `args += ['--config', 'model_provider=<name>']` — selects the provider's
  `[model_providers.<name>]` block in `codex_config.toml`, which resolves its
  `base_url` + `env_key` + `wire_api = "responses"`. (An earlier design overrode
  the OPENAI provider's URL with `--config openai_base_url=...`; that hijacked
  the request to openai/chatgpt auth and the openai model list instead of using
  the provider's own auth/wire_api — see `.claude/memory/2026/08/25/…` for the
  DeepSeek setup script's rationale, which deletes any global `openai_base_url`.)
- `args += ['--model', <codex model>]` — codex has no model env var, only a
  `--model` CLI flag. The model derives from the catalogue's `models.codex ?? models.base`
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
OpenAI's models in the picker. The `cods` launcher passes it via `--config`
only when a provider is selected.

**The `[model_providers.<id>]` block is generated, not maintained by hand.**
`scripts/setup/inject-codex-providers.mjs` writes one block per provider from
the provider cache and the projection rules (base_url = the row's openai endpoint, env_key =
`codexApiKeyEnv`, `wire_api = "responses"`) between the
`# === setup-managed: model_providers` markers, and `npm run setup` runs it every time.
The block is regenerated per host into `~/.codex/config.toml` and never reaches the
shared `codex_config.toml`, which carries only the hand-edited head — see
`docs/sync-architecture.md` § 3 for why those are two different files.

**End-to-end caveat:** DeepSeek natively supports the Responses API (`wire_api =
"responses"`), and its `deepseek-v4-*` models need a `~/.codex/models.json`
catalog (context window, reasoning levels, image input for the vision model) for
Codex to accept them. The launcher supplies the right env/config/`--model`; the
`models.json` catalog is generated by `scripts/setup/inject-codex-providers.mjs`.

DeepSeek is intentionally the only third-party provider. `codc` launches the
official Codex provider without overrides; `cods` launches DeepSeek. Standalone
wrappers are generated by `scripts/setup/install-cli-wrappers.js` and require no
shell-profile sourcing.

## Model & Effort Strategy

The fleet runs `model: "opus[1m]"` with `effortLevel: "low"` — both in
`claude_settings.json`, and `modelSettings` can pin a different effort per model. For
critical plan sessions, run `/effort high` before `/plan`.

The sharp-review Stop hook is a **wave-gated adaptive trigger**, not a classifier: it
tracks change accumulation per ref and fires `/sharp-review` when the diff crosses a
threshold — wave 0 (new territory) at 300 lines / 5 files, wave 1+ (already reviewed once
at this ref) at 1000 lines / 15 files, resetting to wave 0 when HEAD moves. Thresholds are
per-project in `.claude/.rem-state.json` → `reviewGate.thresholds`; all review logic lives
in the skill.
