---
name: sync-migration-runbook-retired
description: The one-time cloud-sync migration runbook, retired 2026-09-20 once all three hosts were on the split layout
metadata:
  type: project
  created: 2026-09-20
---

# The sync migration runbook (retired)

This was section 8 of `docs/sync-architecture.md`. It moved here on 2026-09-20 because the
migration it describes is complete on all three hosts: the git working tree no longer lives
in cloud storage anywhere, and the legacy `<OneDrive>/Sync/claude/` directory has been
deleted (verified — teardown step 7 is done). Keeping a step-by-step runbook in a live design
document means a reader cannot tell which parts of that document describe the system and
which describe a migration that already happened.

The layout itself is still documented — `docs/sync-architecture.md` sections 3 through 5
are the parts that matter. This file is history.

## 8. Migration runbook

### This machine (macOS, done first)
1. `git clone https://github.com/DawnEver/claude-code-config.git ~/Documents/Code/AI/cc-config` ✅
2. Create `<OneDrive>/Sync/cc-config/`, **move** the 3 Tier B files there.
3. Implement §6 on the new clone; `npm test`; commit; push.
4. `node scripts/setup/setup.js --sync-dir "<OneDrive>/Sync/cc-config" --replace`
5. Verify every `~/.claude` / `~/.codex` link resolves to `~/Documents/Code/AI/cc-config`
   or `<OneDrive>/Sync/cc-config` — and **nothing** to `<OneDrive>/Sync/claude`.
6. Smoke-test `ccc`, `ccds`, `cods`, `todo`.

`<OneDrive>/Sync/claude/` is left in place for now, deliberately: it is the rollback
and it still holds the other machines' state until they migrate. It must be deleted
only after step 7 completes everywhere, because while it exists it keeps replicating a
poisoned `.git` between hosts.

### Each other machine (G, WS1/`duip622037`)
1. Let OneDrive settle, confirm `<OneDrive>/Sync/cc-config/` has arrived **with all
   three files**. Do not run setup against an empty payload dir — it now refuses, but
   check anyway.
2. `git clone … ~/Documents/Code/AI/cc-config` (Windows: any non-synced path).
3. `node scripts/setup/setup.js --sync-dir "<OneDrive>/Sync/cc-config" --replace`
4. Confirm `~/.claude/claude_env_settings.local.json` still holds that host's API keys
   (it is Tier C — untouched by the migration, but verify before deleting anything).
5. **Stop using `<OneDrive>/Sync/claude` immediately.** Before that host forgets, check
   `git -C "<OneDrive>/Sync/claude/cc-market" status` for unpushed plugin work and push it.
6. Smoke-test the launchers.

### cc-market
`cc-market/` is its own git repo (`DawnEver/cc-market`), gitignored here and cloned by
setup into the repo dir. It therefore moves with the working tree automatically, and
`npm run setup` clones it fresh at the new location.

It also matters for teardown: `setup.js` runs `git pull --ff-only` inside
`<sourceDir>/cc-market` on every run. So an un-migrated host keeps invoking git against a
cloud-replicated `.git` — the same failure mode this document exists to stop, just for
cc-market instead of the config repo. Plugin development happens there, so it holds real
uncommitted work. **Delete `<OneDrive>/Sync/claude/cc-market` first, not last.**

### Step 7 — teardown, only when all hosts are done
Delete `<OneDrive>/Sync/claude/`. Until then it is *not* inert: any host that still runs
setup from it keeps exercising git inside a synced directory (see cc-market above). The
old dir is the rollback, but it is a rollback with a running cost.
