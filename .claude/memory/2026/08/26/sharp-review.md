---
name: sharp-review-2026-08-26
description: Sharp review findings — 3 total
metadata:
  type: project
---

## Review 2026-08-26 (session) — diff review + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20260826-001] [MEDIUM] scripts/setup/setup.js:334-357 — models.json generation is gated on codex_config.toml existing, so the ~/.codex/models.json link can be silently skipped

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Split the two: run `generateModelsJson`/`injectModelsJson` unconditionally (it only needs the providers registry), keep only `injectModelProviders` behind the codex_config.toml check. Read `claude_env_settings.json` once outside the try, and if it fails to parse, emit an ERR and increment `counters.errors` instead of a NOTE.

The whole injection block — including `generateModelsJson`/`injectModelsJson`, which writes the gitignored repo `models.json` — sits inside `if (fs.existsSync(codexConfigPath))`. The two artifacts are unrelated: the model catalog derives purely from `providers.<name>.models`. If `codex_config.toml` and its template are absent (Claude-only clone, deleted config, partial sync), `models.json` is never written; `CODEX_LINKS` then hits `linkEntry`'s `source not found` branch and prints `SKIP models.json`, counted as a skip, not an error. Same outcome if the `JSON.parse` of `claude_env_settings.json` throws — the catch prints a `NOTE` and setup continues to report success while the catalog the diff exists to guarantee is missing. This is exactly the failure mode ('model provider not found' / codex 0.149 rejecting the deepseek-v4-* models) the change claims to have eliminated, only now it fails quietly.

---

### [SR-20260826-002] [MEDIUM] scripts/setup/check-links.js — SessionStart self-heal can never repair a missing models.json — it only re-links, and the source is gitignored/generated

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Have `check-links.js` call the same `generateModelsJson`/`injectModelsJson` pair (and `injectModelProviders`) before verifying links, or at minimum detect a missing/dangling `models.json` and print the `npm run setup` fix command the way it already does for drifted plain files.

`check-links.js` (run on SessionStart and by `codex.js`, per AGENTS.md) recreates missing links but has no knowledge of the generated `models.json` (grep finds no reference). Because `models.json` is gitignored and only produced by `setup()`, any machine that syncs the repo without re-running setup — or that lost the file — gets a permanently unhealable dangling `~/.codex/models.json`. The healer will report everything fine while `cods`/`cogmi` keep failing. The README's mitigation ('a stale install may miss these until setup is re-run') is a manual workaround for a path that already has automation.

---

### [SR-20260826-003] [LOW] scripts/setup/inject-codex-providers.mjs:196-201 — Trailing-newline normalization indexes with endIdx === -1 when no markers exist

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Guard the normalization on `endIdx !== -1`, and treat the no-marker/append case as 'suffix is empty' explicitly.

In `injectModelProviders`, the normalization check `existing.slice(endIdx + CODEX_TOML_END_MARKER.length) === ''` runs even in the no-marker branch, where `endIdx` is `-1`. The slice then starts at an arbitrary offset near the top of the file rather than at end-of-content, so the comparison is meaningless and the wrong normalization branch is taken on first injection. Harmless today (both branches yield a parseable TOML) but it defeats the stated purpose — making the second-run `no-change` comparison apples-to-apples.
