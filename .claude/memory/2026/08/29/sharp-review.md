---
name: sharp-review-2026-08-29
description: Sharp review findings — 15 total
metadata:
  type: project
---

## Review 2026-08-29 (session) — architecture survey (架构锐评) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): skipped
- Reviewer kimi (kimi): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20260829-001] [HIGH] docs/sync-architecture.md — codex_config.toml is machine-written by Codex itself, not hand-edited — Tier B is the wrong classification and syncing it guarantees conflict copies and cross-OS path pollution

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split codex_config.toml: sync only the hand-edited head (model/sandbox/TUI) and generate ~/.codex/config.toml per host as synced-head + local [projects.*] + the setup-managed marker block (a marker protocol already exists in inject-codex-providers.mjs). At minimum drop it from Tier B and correct §3/§10.

§3 claims Tier B files are 'small, hand-edited, rarely written concurrently'. The live codex_config.toml disproves this: ~25 auto-appended [projects.'...'] trust blocks written by Codex on every new project directory, mixed OS and mixed absolute paths (c:\users\linxu\onedrive - ... alongside /Users/linxu/Library/CloudStorage/...). Written by a daemon-like process on every host without coordination. Putting it in a cloud folder reproduces the two-writers problem the design exists to eliminate, at lower frequency. §10 dismisses this on a false premise. Each host also accumulates other hosts' dead project paths forever.

---

### [SR-20260829-002] [HIGH] scripts/setup/check-links.js — check-links.js duplicates the link loop and hardcodes sourceDir; the doc's change list omits it, so every SessionStart heal and codex launch silently breaks after the move

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Extract resolveLinkSource(link, {sourceDir, syncDir}) shared by processLinks and check-links, and thread syncDir into check-links' regenerateCodexArtifacts call. Add this file to §6.

§6 only changes processLinks() in setup.js. check-links.js:56-58 independently computes srcPath = path.join(sourceDir, link.src), and lines 39-41 hardcode sourceDir/claude_env_settings.json, sourceDir/codex_config.toml, sourceDir/models.json. After the move those no longer exist in the repo: (a) linkEntry returns status:'skip' 'source not found', which check-links filters out of warnings, so the three most important links become permanently unverifiable; (b) regenerateCodexArtifacts sees settings 'missing', treated as pre-setup state and silent, so models.json is never regenerated and codexConfigPath returns 'no-config' so [model_providers.*] is never re-injected. The self-heal machinery stops working with no message.

---

### [SR-20260829-003] [HIGH] skills/migrate/migrate.js — migrateRetiredPlugins() defaults settingsPath to sourceDir/claude_settings.json and returns [] on a missing file — after the move it becomes a permanent silent no-op

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Grep every join(sourceDir, ...) naming a Tier B file before implementing. Point this at the resolved sync dir or at ~/.claude/settings.json (the link, always correct), and log a warning instead of returning [] indistinguishably from 'nothing to do'.

migrate.js:181 path.join(sourceDir, 'claude_settings.json'), then line 183 returns [] if missing. Once claude_settings.json lives in the sync dir this never exists in the repo, so retired-plugin migration silently no-ops and main() prints 'OK no retired plugin entries in claude_settings.json' — an actively false report. The doc claims only two repo-relative Tier B consumers (cc.js, codex.js); there are at least four.

---

### [SR-20260829-004] [HIGH] scripts/setup/setup.js — Template-copy blocks run unconditionally against syncDir, so a setup run on machine 2 before OneDrive finishes downloading manufactures template Tier B files and produces conflict copies of all three

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Gate template-copy on the sync dir looking initialized: if the pointer was just written and syncDir is empty/absent, refuse and print 'sync dir <path> is empty — wait for sync, or pass --init-sync-dir to seed from templates'. Never auto-seed a directory just declared to be a shared payload.

setup.js:266-290 does if (!existsSync(x)) copyFileSync(template, x) for all three Tier B files. Redirecting that at syncDir makes the runbook's 'let OneDrive settle, confirm the dir has arrived' a load-bearing manual precondition with zero code enforcement. Run step 3 early, or hit Files-On-Demand placeholders, and setup writes desensitized templates into the cloud dir; OneDrive then reconciles a local write against an incoming remote version: conflict copies of all three files, and meanwhile the host runs on template config with no providers. This is the migration's single most likely failure and the doc treats it as prose.

---

### [SR-20260829-005] [HIGH] docs/sync-architecture.md — §9's claim that the old OneDrive dir is 'inert but harmless as long as no host runs git inside it' is false — setup.js runs git pull inside <OneDrive>/Sync/claude/cc-market on every setup run

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add cc-market to the tier table (its own git repo, must live beside the working tree, never in cloud) and add a runbook step: stop using the old dir immediately after cloning, and check git -C <OneDrive>/Sync/claude/cc-market status for unpushed work. Delete <OneDrive>/Sync/claude/cc-market first, not last.

setup.js:377-385 executes git pull --ff-only with cwd path.join(sourceDir, 'cc-market') whenever cc-market/.git exists. cc-market is a separate git repo cloned into the repo dir and currently exists at <OneDrive>/Sync/claude/cc-market/.git. Any un-migrated host — which the runbook explicitly leaves running during migration — keeps invoking git against a OneDrive-replicated .git, exactly the failure mode this doc exists to stop, just for cc-market instead. Plugin development happens inside cc-market, so it holds real uncommitted work. The doc never mentions cc-market once.

---

### [SR-20260829-006] [MEDIUM] docs/sync-architecture.md — §10's claim that the claude-hud hard link's exposure is 'strictly reduced' is backwards — config.json is git-tracked, and git becomes the new frequent replacing writer

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Correct the §10 claim. Better: ship claude_plugins/claude-hud/config.template.json, gitignore the real one, and drop the hard-link fragility class entirely.

The entry survives the move mechanically (repo-based src, dest under ~/.claude/plugins, same volume, linkSync succeeds; linkEntry's ino/dev check still recognizes it). But git ls-files confirms claude_plugins/claude-hud/config.json is tracked. A hard link breaks when a writer replaces the inode, and setup.js:139-143 documents git checkout as exactly such a writer. The design makes git pull/checkout the primary transport for Tier A, so the breaking event goes from 'occasional OneDrive sync-down' to 'every pull touching this file'. check-links auto-repair covers it, but the doc's stated risk direction is wrong, and a per-machine tuned file (lineLayout, language, maxWidth) should not be tracked at all.

---

### [SR-20260829-007] [MEDIUM] docs/sync-architecture.md — --sync-dir moves files with no crash-safety, no idempotency story, and no guard against a second host running it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Specify: move only when dest is absent, refuse (don't overwrite) when present and non-identical, copy+verify+unlink for EXDEV, and write the pointer file LAST after every file is confirmed at the destination. Add a crash-mid-move test.

§4(c) says the flag 'moves' Tier B files and §9 leans on that being reversible. Unspecified: (1) ordering — if the pointer is written first and the move throws (EXDEV across volumes, EPERM on a OneDrive placeholder), the next plain npm run setup sees syncDir missing the files, template-copies fresh ones, and links ~/.claude/settings.json at a template while the real settings sit orphaned in the repo dir; (2) behaviour when the destination already exists; (3) two hosts running the flag concurrently against one cloud dir. A rename across devices needs copy+fsync+unlink; the doc just calls it a move.

---

### [SR-20260829-008] [MEDIUM] skills/migrate/migrate.js — Orphan cleanup will NOT delete tier-B links (safe), but the same filter makes stale links to the OLD sync dir permanently invisible to cleanup

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Extend findOrphanedLinks to treat any dangling symlink under ~/.claude and ~/.codex as an orphan (check-links can re-link them). Make it an explicit step-7 precondition check.

findOrphanedLinks (migrate.js:53-58) resolves each symlink with realpathSync and continues unless the target is sourceResolved or under it. A link to <cloud>/claude_settings.json resolves outside the repo and is skipped before the goodDests.has(rel) test — nothing is deleted. Belt-and-braces: 'settings.json', 'claude_env_settings.json', 'config.toml' remain in goodDests regardless of base. The mirror-image defect is real though: after migration ~/.claude/settings.json points into the cloud dir; if the pointer later changes (rollback, renamed cloud folder, changed OneDrive path) the stale link is outside sourceDir and can never be reported or cleaned. Since step 7 deletes <OneDrive>/Sync/claude, a host with a stale pointer ends up with three dangling links and no tool that notices.

---

### [SR-20260829-009] [MEDIUM] docs/sync-architecture.md — Invariant 'no absolute cloud path in any shared file' is already violated by the shared files today, and the design does nothing to enforce it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State the invariant per tier (tracked: enforced; Tier B: currently violated) and add a setup-time lint that greps resolved Tier B files for /Users/, C:\, c:/ and warns. Fix the motronics-studio entry to a ~-relative or per-host local override before the first cross-machine sync.

§2 constraint 4 states it as an invariant and §5 rests on it. Live payload: claude_env_settings.json:52 contains "motronics-studio": "C:/Users/linxu/Documents/PEMC/motronics-studio" — a Windows absolute path in a file about to be shared with a macOS host; codex_config.toml is saturated with them. The invariant holds for tracked files but is false for the Tier B payload, which is exactly where it matters since those files cross the username/OS boundary. The doc asserts rather than checks.

---

### [SR-20260829-010] [MEDIUM] scripts/setup/setup.js — setup() reads process.argv directly, so the proposed --sync-dir flag is invisible to programmatic callers and leaks into them

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Refactor to setup({replace, syncDir} = parseArgs(process.argv.slice(2))) with the CLI entry as the only argv reader. Better: make the pointer-writing move a separate subcommand — 'moves user data' and 'creates symlinks idempotently' should not share an entry point.

setup.js:262 const args = process.argv.slice(2) inside setup() — the function takes no options. migrate.js:281 calls setup() after its own arg parsing, so node skills/migrate/migrate.js --sync-dir /somewhere would silently trigger a pointer write and a file MOVE from inside a tool that advertises link cleanup. There is also no way for a test to invoke setup with an explicit sync dir. A destructive move behind an argv sniff in a shared re-entrant function is the wrong place for it.

---

### [SR-20260829-011] [MEDIUM] docs/sync-architecture.md — OneDrive Files-On-Demand placeholders are never considered, yet the design links directly at cloud-resident files

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document the requirement to pin the sync folder to 'Always keep on this device', and have --sync-dir verify readability (read + parse each Tier B file) rather than trusting existsSync.

Under Files-On-Demand a dehydrated file exists to lstat/existsSync but the first read blocks on a network fetch or fails offline. The design makes ~/.claude/settings.json a symlink to such a file, and cc.js/codex.js read claude_env_settings.json from it on every launcher invocation — the critical path of every ccc/cods run. codex.js already carries a 24h throttle comment specifically because 'on a OneDrive-backed Windows FS, a cold-cache stat per link can block for hundreds of ms'; the design moves the actual config reads onto that filesystem. Offline launch behaviour is undefined, and existsSync cannot distinguish a placeholder from a real file.

---

### [SR-20260829-012] [LOW] scripts/runtime/cc.js — cc.js/codex.js do not need resolveSyncDir at all — ~/.claude/claude_env_settings.json is already the link that exists for exactly this purpose

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** const envSettingsPath = join(homedir(), '.claude', 'claude_env_settings.json'); in both launchers (codex.js already imports homedir). Then resolveSyncDir is imported by setup.js and check-links.js only.

§6 imports a new module into both launchers to recompute a path setup has already materialized as ~/.claude/claude_env_settings.json (CLAUDE_LINKS entry, setup.js:29). §4 itself argues 'a shared config never names a cloud path, it names ~/.claude/... and lets the per-host link resolve it' — then the next section has the two runtime hot-path consumers bypass that link and re-derive the cloud path. Using the link is one line, has no bootstrap concern, works if the repo moves, and keeps resolveSyncDir's blast radius to setup.js as §4 promised.

---

### [SR-20260829-013] [LOW] .gitignore — The .gitignore claim is correct, but gitignoring Tier B guarantees a stale repo-dir copy shadowing the sync copy is invisible

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** After a successful --sync-dir move, warn on every subsequent setup run if a Tier B file reappears in the repo dir while a pointer is set: 'stale <file> in repo dir shadowing the sync copy — delete it'.

Verified: claude_env_settings.json, claude_settings.json, codex_config.toml and models.json are all in .gitignore. For syncDir === repoRoot they all still apply and the zero-config path is genuinely unchanged, so §6's reasoning holds. The gap: nothing prevents a rollback or half-migrated state from leaving a stale Tier B file in the repo dir where it is invisible (gitignored) and silently wrong — the exact drift §4 says the move prevents. The ignore rules guarantee git will never tell you the duplicate is there.

---

### [SR-20260829-014] [LOW] docs/sync-architecture.md — Bootstrap ordering is fine (no cycle), but the doc never says why, and the pointer file lacks any format/validation contract

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State the no-cycle reasoning explicitly (it is load-bearing and non-obvious). Have resolveSyncDir/setup hard-fail when a pointer is set but the target directory does not exist, instead of creating it — create-if-missing belongs only to the explicit --sync-dir path.

No chicken-and-egg: ~/.claude is a real per-machine directory (setup.js only links specific children, never ~/.claude itself) and ~/.claude/sync-dir is a plain file, so resolveSyncDir depends on nothing setup creates. Unstated risks instead: the pointer is read with existsSync + readFileSync().trim() and never validated, so a pointer at a deleted/unmounted/typo'd path silently yields a syncDir that setup will happily mkdir and template-seed, producing a plausible-looking but empty config on a host that had a working one. §6's 'startup banner prints the resolved sync dir' is human-eyeball mitigation for a machine-checkable condition.

---

### [SR-20260829-015] [LOW] docs/sync-architecture.md — §7 test plan covers only the easy pure function and misses every regression this change is most likely to cause

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add the five cases above. Write the findOrphanedLinks and check-links tests BEFORE the setup.js change — they are the two places where this design fails silently rather than loudly.

The listed tests cover resolveSyncDir's precedence table thoroughly — the obviously-correct part. Nothing covers: check-links.js resolving Tier B under syncDir; migrateRetiredPlugins finding claude_settings.json; findOrphanedLinks leaving base:'sync' links alone (worth a test precisely because a future refactor of the realpath filter would start deleting live config); regenerateCodexArtifacts receiving a syncDir codexConfigPath and a sourceDir modelsPath in the same call; the --sync-dir move being crash-safe and refusing to clobber. Also scripts/setup/setup.test.mjs does not exist — §7 describes it as if extending a file, and setup.js has no test coverage today, so a 415-line module full of destructive filesystem branches is being modified blind.
