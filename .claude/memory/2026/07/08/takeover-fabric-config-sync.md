---
name: takeover-fabric-config-sync
---

# takeover→fabric config sync (parent repo)

The `takeover` cc-market plugin was merged into `fabric` (one `call` primitive; see
cc-market `fabric/.claude/memory/2026/07/08/persistent-sessions-and-takeover-merge.md`).
Synced this parent repo's config to match:

- **`claude_settings.template.json`** + live **`claude_settings.json`** (gitignored):
  permissions `Skill(takeover:continue/models/summary)` → `Skill(fabric:continue/models/summary)`,
  `mcp__plugin_takeover_takeover__call_model` → `mcp__plugin_fabric_fabric__call`,
  `mcp__plugin_takeover_takeover__list_models` → `mcp__plugin_fabric_fabric__list_providers`.
  Dropped `takeover@cc-market` from `enabledPlugins` (fabric already enabled).
- **`scripts/setup/setup.js`**: no longer mutates `enabledPlugins` at all. Plugin
  enablement + the cc-market marketplace live in `claude_settings.template.json`, which setup
  copies on a *fresh* install; `settingsPath` remains only for that copy. Existing-install
  deltas are migrate's job. (Removed the old "ensure fabric enabled" block as dead weight —
  the template already carries it.)
- **`skills/migrate/migrate.js`** (`migrateRetiredPlugins`, step E, exported+tested): the
  *migration* — on existing installs, removes a retired plugin's `enabledPlugins` key + its
  permission-allow entries, enables the replacement, and transfers the trusted skill/MCP
  perms. Driven by `RETIRED_PLUGINS` (`takeover@cc-market` → `fabric@cc-market`).
  **Architectural rule confirmed this session: setup.js = baseline; migrate = removing/
  swapping stale entries.** Idempotent, `--dry-run` aware, injectable `settingsPath` for tests.
- **`.claude/rules/rem/{cc-market-repo,hook}.md`**: plugin-list prose `takeover` → `fabric`.

Note: `claude_env_settings.template.json` (provider env blocks) has NO takeover reference —
it needed no change; the tool/skill namespaces live in `claude_settings*.json`.

Permission changes apply on next session load / `/reload-plugins`. Parent-repo changes not
yet committed at time of writing.
