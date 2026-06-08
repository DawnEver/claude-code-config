---
name: sharp-review-2026-06-09
description: Sharp review of setup.js shared-cache fix — symlink vs copy, dynamic plugin discovery
created: 2026-06-09
accessed: 2026-06-08
tier: short
---

## Review 2026-06-09 — setup.js shared cache fix

### Reviewer Status
- Reviewer A (Codex, via takeover): OK
- Reviewer B (DeepSeek, via takeover): OK
- Reviewer C (Claude, native): OK

### Confirmed findings

---

### [SR-20260609-001] [HIGH] scripts/setup/setup.js — Hard-coded plugin list ('rem', 'sharp-review', 'watch') will silently skip any new plugin, causing broken imports later.

- **Category:** Bug
- **Module:** setup script
- **Status:** FIXED
- **Suggestion:** Discover plugin directories dynamically from the cc-market cache folder instead of using a fixed array.

---

### [SR-20260609-002] [MEDIUM] scripts/setup/setup.js — Redundant copies of identical .mjs files into every plugin's cache directory; wastes disk and creates an update problem.

- **Category:** Feature
- **Module:** setup script
- **Status:** FIXED
- **Suggestion:** Use symlinks or a single shared location accessible to all plugins so imports resolve without duplication.

---

### [SR-20260609-003] [HIGH] scripts/setup/setup.js — Shared files are copied instead of symlinked, so updates to cc-market/shared/ require re-running setup to propagate

- **Category:** Bug
- **Module:** setup
- **Status:** FIXED
- **Suggestion:** Use fs.symlinkSync to create a symlink from pluginCache/shared → cc-market/shared/, consistent with how the rest of setup.js works

---

### [SR-20260609-004] [MEDIUM] scripts/setup/setup.js — Plugin list ['rem', 'sharp-review', 'watch'] is hardcoded and will silently skip any future plugin that also imports ../shared/

- **Category:** Feature
- **Module:** setup
- **Status:** FIXED
- **Suggestion:** Enumerate all subdirectories of pluginCacheBase dynamically (fs.readdirSync(pluginCacheBase)) rather than maintaining a static allowlist

---

### [SR-20260609-005] [MEDIUM] scripts/setup/setup.js — The fix assumes ../shared/ relative import convention holds forever; a version bump that changes nesting depth silently breaks imports again

- **Category:** Bug
- **Module:** setup
- **Status:** OPEN
- **Suggestion:** Fix the import at the source — change plugins to use an absolute path or a package.json import map so the relative path is not fragile across versioned cache layouts

---

### [SR-20260609-006] [LOW] scripts/setup/setup.js — Silent no-op when pluginCacheBase does not exist on a fresh install

- **Category:** Bug
- **Module:** setup
- **Status:** FIXED
- **Suggestion:** Log a notice when pluginCacheBase is missing so the user knows to install plugins first
