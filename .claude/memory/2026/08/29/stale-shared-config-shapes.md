---
name: stale-shared-config-shapes
description: A gitignored shared file can silently lag a tracked schema change — claude_env_settings.json was still the pre-refactor env:* shape while the code required providers.<name>, so models.json generated empty. Rebuild from the tracked template, preserve host-fleet blocks.
metadata:
  type: project
---

# A gitignored shared file can silently lag a tracked schema change

Found 2026-08-29 during the cloud-sync migration, as a side effect — not the thing being
looked for, which is why it is worth recording.

## Symptom

After repointing setup at the new payload dir, `models.json` generation reported:

```
NOTE   models.json — no provider declares a codex model; nothing to inject
SKIP   models.json - source not found
```

`cods` / `cogmi` would have failed with "model provider not found".

## Cause

`claude_env_settings.json` in the payload still had the **pre-refactor shape**:

```
top-level keys: env:claude, env:codex, env:deepseek, env:kimi, fabric
```

whereas the code on `origin/main` requires `providers.<name>` with `codexPath` and `models`.
The providers refactor had been done on another host and pushed — but **the file is
gitignored**, so the new shape never propagated through git, and the cloud copy this machine
had was simply old.

This is the general trap: `*.template.json` is tracked and evolves with the code; the real
file is gitignored and evolves only by hand or by whatever the sync daemon last delivered.
Nothing enforces that they stay in the same shape, and nothing *reports* the mismatch —
the generator just produced an empty catalogue.

## Fix

Rebuild the shared file from the tracked template, carrying over the blocks that are genuine
fleet state rather than schema:

```js
{ providers: template.providers,          // new shape, has codexPath + models
  fabric:    old.fabric ?? template.fabric } // real token / nodes / sessionDefaults
```

Result: 3 providers, 7 model catalogue entries generated. Old file preserved as
`claude_env_settings.json.pre-providers-bak`.

Note the API keys needed no rescue — `setup.js` had already migrated the machine-local
`~/.claude/claude_env_settings.local.json` to `providers.<name>.apiKey` on its own
(`migrate-local-env-settings.mjs`). Only the **shared** half was stale, which is exactly the
half git cannot see.

## Worth doing eventually

A setup-time shape check: compare the resolved payload's top-level key set against the
template's and warn on divergence. Same place would suit the absolute-path lint —
`claude_env_settings.json` still carries
`"motronics-studio": "C:/Users/linxu/Documents/PEMC/motronics-studio"`, a Windows path in a
file shared with macOS.
