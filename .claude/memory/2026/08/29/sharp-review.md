---
name: sharp-review-2026-08-29
description: Sharp review findings — 33 total
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


## Review 2026-08-29 (follow-up)

## Review 2026-08-29 (session) — diff review + architecture survey (架构锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): FAILED
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20260829-016] [HIGH] scripts/setup/setup.js — The empty-sync-dir seeding guard is per-directory but seeding is per-file, so a partially-downloaded payload dir still gets template-seeded into cloud storage — SR-004 is only half fixed

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Make the guard per-file: replace `payloadPresent = SYNC_PAYLOAD_FILES.some(...)` with a per-file check inside each copy block, i.e. only seed file F when `!usingSyncDir || args.includes('--init-sync-dir')`. `payloadPresent` should not authorize seeding a *different* file. Better still: treat "using a sync dir" as "never seed unless --init-sync-dir", full stop.

`seedTemplates = !usingSyncDir || payloadPresent || args.includes('--init-sync-dir')` where `payloadPresent = SYNC_PAYLOAD_FILES.some(f => fs.existsSync(path.join(syncDir, f)))`. But the three copy blocks below are each guarded only by `seedTemplates && !fs.existsSync(<that file>)`. A cloud client downloads files one at a time, so a dir containing claude_settings.json but not yet codex_config.toml is the *normal transient state* during the very migration this commit describes. In that state `payloadPresent` is true, `seedTemplates` is true, and setup copies `codex_config.template.toml` into the cloud dir. OneDrive then reconciles that local write against the incoming real codex_config.toml — the conflict copy the guard was written to prevent, plus a host running on a desensitized template with no providers. Same for a machine whose payload dir legitimately holds only two of the three files. The guard's own comment ("an empty shared dir usually means the cloud client has not finished syncing") describes exactly the case it fails to cover: partial sync, not zero sync.

---

### [SR-20260829-017] [HIGH] scripts/setup/codex-config-compose.mjs — splitCodexConfig silently drops content it cannot classify, and the result is written back over the cloud payload — a multi-line TOML string or an [[array-of-tables]] causes permanent, fleet-wide data loss and can emit unterminated TOML

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a losslessness invariant: reconstruct `preamble + shared + generated + local` and refuse to rewrite the payload (or compose) unless it equals the input modulo whitespace. Track multi-line basic/literal string state (`"""` / `'''`) and open bracket depth so header detection is suppressed inside them. Recognise `[[name]]` explicitly and route it like a table. Long-term: use a real TOML parser (`smol-toml`/`@iarna/toml`) instead of a line sectioner on a file you overwrite in place.

Verified by running the module directly.

(a) Multi-line string: input `instructions = """\n[projects.fake]\nstill in string\n"""\nmodel = "x"\n\n[tui]\ntheme="a"\n` → `sharedHeadOf` returns `instructions = """\n\n[tui]\ntheme = "a"\n`. The string body, the closing `"""` and the `model` key are all gone, the head is now *syntactically invalid TOML*, and `[projects.fake]` was misclassified as machine state. `composeCodexConfigFile` then writes that head over the cloud payload and into `~/.codex/config.toml`, breaking Codex on every host.

(b) Array-of-tables: input `model="x"\n[notice]\na=1\n\n[[mcp_servers]]\nname="z"\n` → head is just `model = "x"`. `[[mcp_servers]]` does not match `/^\s*\[([^\]]+)\]\s*$/` (the second `]` defeats `\s*$`), so it is absorbed as *content of the preceding section*; because that section was `[notice]` (local), the whole array-of-tables is stripped and deleted from the shared payload. Generally: any unclassifiable line inherits the local/shared verdict of whatever table happens to precede it.

There is no round-trip assertion anywhere; `splitCodexConfig` has no test that the parts reconstruct the input. The whole file passes through this on every setup run *and* every SessionStart via check-links.js.

---

### [SR-20260829-018] [HIGH] scripts/setup/setup.js — composeCodexConfigFile discards this host's own Codex project-trust list on the first upgrade run, even though it is holding those sections in a local variable at the time

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Recover locals from the payload when the target is a symlink into the (now-moved) payload: `if (stat.isSymbolicLink()) localSections = localSectionsOf(payloadText)` — you already parsed it, `leaked` is literally its count. Only start clean when the symlink resolves somewhere unrelated. At minimum, log how many trust blocks are being dropped instead of dropping them silently.

`if (!stat.isSymbolicLink()) localSections = localSectionsOf(...)` — on every pre-migration host `~/.codex/config.toml` IS a symlink (it was in CODEX_LINKS until this commit), pointing at the repo's own `codex_config.toml`. The comment justifies discarding with "its local sections belong to the fleet, not this host" — but in the zero-config single-machine case (syncDir === repoRoot, the default this module advertises as "byte-identical to before") that symlink points at *this host's own* accumulated config. The 30 `[projects.*]` blocks the commit message cites are then read as `leaked`, counted, stripped from the payload, and thrown away. Result of a routine `npm run setup` after upgrading: Codex re-prompts trust for every project directory on the machine, with no warning that it happened and no backup to recover from. The data is in `payloadText`, five lines above, and is deliberately not used.

---

### [SR-20260829-019] [HIGH] scripts/setup/setup.js — composeCodexConfigFile overwrites both the cloud payload and ~/.codex/config.toml with non-atomic writeFileSync, no backup and no validation — the opposite of the care linkEntry takes

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Write to `<path>.tmp` + `fs.renameSync` for both writes so a crash cannot truncate a cloud-replicated file. Before the first destructive rewrite of the payload, copy it to `codex_config.toml.pre-split-bak` (linkEntry already does exactly this with `.setup-bak`). Refuse to write a head that is empty/whitespace when the input was not.

Two unguarded whole-file writes: `fs.writeFileSync(payloadPath, head)` (a cloud-synced file, replicated to every machine) and `fs.writeFileSync(target, next)` (~/.codex/config.toml). Both are `open(O_TRUNC)` + write; a crash, a full disk, or an EPERM from the cloud client mid-write leaves a truncated config that then replicates. There is no `.bak` of the payload before the one-way strip, so if the sectioner mangles the file (see the splitCodexConfig finding) there is no recovery path — the pre-split content exists only in whatever the cloud client's version history happens to retain. Contrast `linkEntry` in the same file, which explicitly renames aside, restores on throw, and keeps drifted copies, with a comment about the time a live `~/.claude/settings.json` was lost. The newer, more destructive code got none of that discipline. Degenerate case: a payload whose head parses to nothing yields `head === '\n'`, which is duly written over the shared file, permanently blanking the fleet's Codex settings.

---

### [SR-20260829-020] [MEDIUM] scripts/setup/setup.js — adoptSyncDir writes the pointer BEFORE the move and uses a bare renameSync — EXDEV/EPERM leaves a configured pointer, files stranded in the repo, and a half-moved payload with no rollback

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Do it in the order the prior review specified: copy each file to the destination, fsync/verify, unlink the source, and write the pointer LAST, only after all three are confirmed. Catch `EXDEV` and fall back to copyFile+unlink. On any per-file failure, roll back the files already moved and do not write the pointer.

`writeSyncDirPointer(target, home)` runs before the rename loop. `fs.renameSync` throws `EXDEV` across volumes — moving from `~/Projects/claude-config` to a OneDrive folder on another drive letter (Windows) or an external/network volume (macOS) is a realistic layout for exactly the user this feature targets — and `EPERM`/`EBUSY` when the cloud client has the destination locked. Failure modes: (1) the throw escapes `setup()` with a raw stack trace after the pointer is already committed; (2) files 1 and 2 moved, file 3 not, no rollback; (3) next plain `npm run setup` now resolves to a sync dir that is empty or partial, which lands in the seeding hole described above. SR-20260829-022 spelled out "write the pointer file LAST after every file is confirmed at the destination" and "copy+verify+unlink for EXDEV"; neither was implemented, and there is no test — `adoptSyncDir` has zero coverage.

---

### [SR-20260829-021] [MEDIUM] scripts/setup/setup-vscode.js — setup-vscode.js still resolves claude_env_settings.json against sourceDir, so `npm run setup_vscode <provider>` hard-fails on any machine that has adopted a sync dir

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** `const envSettingsPath = path.join(os.homedir(), '.claude', 'claude_env_settings.json');` — the same one-line fix already applied to cc.js and codex.js, reading through the link setup materialized.

Line 95: `const envSettingsPath = path.join(sourceDir, 'claude_env_settings.json');` followed by `if (!fs.existsSync(...)) { console.error('ERROR Missing: ...'); process.exit(1); }`. The commit's own message claims it swept the repo-relative payload consumers, and the prior review's SR-20260829-018 suggestion was literally "Grep every join(sourceDir, ...) naming a Tier B file before implementing." This one was missed. It is a documented, package.json-wired entry point (`"setup_vscode": "node scripts/setup/setup-vscode.js"`, listed in AGENTS.md), so the feature is simply dead after migration. It fails loudly rather than silently, which is the only thing keeping this out of HIGH.

---

### [SR-20260829-022] [MEDIUM] scripts/setup/setup.js — setup() still argv-sniffs, so `node skills/migrate/migrate.js --sync-dir /x` triggers a destructive file move from a tool that advertises link cleanup — SR-010 was not fixed and the leaked flag is now destructive

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Change the signature to `setup({ replace = false, syncDir = null, initSyncDir = false } = {})` and parse argv only in the `import.meta`-main guard at the bottom of the file. `migrate.js` then calls `setup({})` and cannot inherit anything. Better: make the pointer-write + move a separate subcommand — "moves user data" and "creates symlinks idempotently" should not share an entry point.

`setup()` still opens with `const args = process.argv.slice(2)` and reads `--sync-dir`, `--init-sync-dir` and `--replace` from it. `skills/migrate/migrate.js` main() calls bare `setup()` after its own arg parsing. The prior review flagged this when the only leakable flag was `--replace`; this commit added two more, one of which writes a machine-local pointer and MOVES three config files. It also means `composeCodexConfigFile`/`adoptSyncDir` cannot be driven from a test without mutating `process.argv`, which is a large part of why neither has any coverage.

---

### [SR-20260829-023] [MEDIUM] scripts/setup/check-links.js — The SessionStart hook and every codex launch now rewrite a cloud-synced file and the live ~/.codex/config.toml, ignore the result, and race a running Codex process

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split composeCodexConfigFile into a pure `computeCodexConfig()` and a writer. In check-links, only write `~/.codex/config.toml` when it differs (it already does) and NEVER write the payload from a hook — make payload normalization a setup-only action. Surface the return value: push a warning on `'no-head'` and on `strippedFromPayload > 0`. Wrap the write so a concurrent Codex append cannot be clobbered (or at least re-read + re-compose immediately before writing).

check-links.js is documented as "Auto-repairs the lossless cases ... A drifted plain file is reported, never touched." It now calls `composeCodexConfigFile`, which can `fs.writeFileSync(payloadPath, head)` — a destructive in-place rewrite of a cloud-replicated file — from a SessionStart hook that fires on every Claude Code session on every machine. Two hosts doing that normalization independently is precisely the two-writers pattern this commit exists to eliminate. Second: `~/.codex/config.toml` is read-modify-written while a `codex` process may be appending its own `[projects.*]` trust block; whichever write lands second wins and the other's change is lost. Third: the return value is discarded entirely, so `status: 'no-head'` (payload dir unmounted / cloud offline) produces no warning at all — the self-heal quietly does nothing, which is the exact failure class SR-20260829-017 was filed about.

---

### [SR-20260829-024] [MEDIUM] scripts/setup/setup.js — composeCodexConfigFile is called unguarded in setup(), so an unreadable payload (Files-On-Demand placeholder, EACCES, offline cloud) throws and aborts setup before a single link is created

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Wrap the call in try/catch, count it into `counters.errors`, and continue to link creation — the same treatment `regenerateCodexArtifacts` gets in check-links.js. Also read the payload with a helper that distinguishes 'absent' from 'unreadable' so a dehydrated OneDrive placeholder produces an actionable message rather than an ENOENT/EIO stack trace.

`const composed = composeCodexConfigFile({ syncDir, envSettingsPath });` sits bare in `setup()` between artifact regeneration and `processLinks`. `fs.readFileSync(payloadPath, 'utf8')` on a Files-On-Demand placeholder can fail offline (`EIO`/`ENOENT` after the hydration attempt), and `fs.existsSync` cannot distinguish that from a real file — the exact scenario SR-20260829-026 raised and this commit does not address anywhere. The consequence is worse than a skipped codex config: setup dies before creating ANY of the `~/.claude` links, so a user running setup on a laptop with the cloud folder unavailable gets a stack trace and no config at all. check-links.js does wrap it; setup.js does not.

---

### [SR-20260829-025] [MEDIUM] scripts/setup/codex-config-compose.mjs — LOCAL_SECTION_PREFIXES claims 'hooks' wholesale while the surrounding comment says '[hooks.state.*]' — user-authored Codex hook config is silently deleted from the shared head

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Narrow the prefix to the actual state tables: match `hooks.state` (and `notice`, `projects`) rather than every `hooks.*`. If the intent really is all of `hooks`, fix the comment and the test, and say so in docs/sync-architecture.md, because it means Codex hooks can never be shared across machines.

The module header says Codex writes `[hooks.state.*]` runtime state, and the test asserts `hooks.state` / `hooks.state."rem@cc-market:..."` as the observed local sections. But `LOCAL_SECTION_PREFIXES = new Set(['projects', 'hooks', 'notice'])` and `topLevelName()` truncates at the first dot, so ANY `[hooks.*]` table is machine-local. Verified: `sharedHeadOf('model = "x"\n\n[hooks.session_start]\ncommand = "echo hi"\n')` returns just `model = "x"`. A user-configured hook in the shared head is stripped on the first setup run and written back over the cloud payload, so it is gone from every machine — silently, since nothing reports what was removed beyond a section count. `[hooks]` is user configuration in Codex, not purely state; the code and its own comment disagree about which.

---

### [SR-20260829-026] [MEDIUM] scripts/shared/sync-dir.mjs — The sync-dir pointer is never validated and setup unconditionally mkdir -p's whatever it names, so a typo'd, renamed or unmounted path silently becomes a brand-new empty config dir

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Have `resolveSyncDir` (or setup) hard-fail when a pointer/env var is set but the target directory does not exist: 'sync dir <path> from ~/.claude/sync-dir does not exist — fix the pointer or re-run with --sync-dir'. Reserve create-if-missing for the explicit `--sync-dir`/`--init-sync-dir` path, where the user asked for it.

`readSyncDirPointer` does `readFileSync().trim()` and returns whatever it finds; nothing checks the path is a directory, exists, or is even absolute. `setup()` then does `fs.mkdirSync(syncDir, { recursive: true })` before the emptiness check, so a mistyped `~/OneDrve/Sync/claude-config` or a cloud folder that the client has not mounted yet gets *created* as a fresh empty directory. The new guard then correctly refuses to seed it — but a subsequent `--init-sync-dir` (the flag the error message itself recommends) will happily seed templates into the wrong place, and a relative pointer resolves against the cwd. This is SR-20260829-029's concrete recommendation, restated: the banner line is human-eyeball mitigation for a machine-checkable condition. A blank pointer is handled; a wrong one is not.

---

### [SR-20260829-027] [MEDIUM] scripts/setup/codex-config-compose.mjs — A [model_providers.*] table outside the markers is classified as SHARED, gets baked into the cloud payload head, and then collides with the regenerated block — duplicate TOML tables, fleet-wide

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Treat `model_providers` as a third, dropped category alongside local: it is always generated, so it should never survive into `shared` regardless of marker presence. One line in the `flush()`/classification branch.

Verified: `sharedHeadOf('model = "x"\n\n[model_providers.custom]\nname = "custom"\n')` returns the `[model_providers.custom]` table verbatim in the head. `composeCodexConfigFile` writes that head into the cloud payload and then `composeCodexConfig` appends the freshly generated marker block below it. If any generated provider shares a name, `~/.codex/config.toml` contains the same table twice — a TOML duplicate-key error, so Codex refuses to start. Reachable whenever the markers are absent or corrupted: a hand-added provider, a truncated file, a marker string change in a future version, or a merge from a host running a different setup revision. And it is sticky: once in the shared head it propagates to every machine and survives every subsequent run, since `sharedHeadOf` is idempotent on it.

---

### [SR-20260829-028] [LOW] scripts/setup/setup.js — earlyErrors reaches counters.errors but setup never sets process.exitCode, so the refuse-to-seed guard reports success to the shell

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** `if (counters.errors) process.exitCode = 1;` next to the final Done line — the `--sync-dir` missing-argument path already does exactly this, so the two error paths currently disagree.

`const counters = { ..., errors: earlyErrors, ... }` correctly folds the guard's error in, and it shows up in `Done: X linked, Y skipped, 1 errors`. But nothing ever assigns `process.exitCode` from `counters.errors`, so `npm run setup` exits 0 after refusing to configure anything. The ERR block is printed near the *top* of a long, chatty run whose last line reads like a success. Since the whole point of the guard is to stop a user who is mid-migration and not reading carefully, the one signal a wrapper or the user's shell prompt could act on is missing. Note the inconsistency: `--sync-dir` with no path sets `process.exitCode = 1` fifteen lines earlier.

---

### [SR-20260829-029] [LOW] scripts/setup/codex-config-compose.mjs — A table header with a trailing comment is not recognised, which both leaks machine-local [projects.*] paths into the cloud payload and collapses the rest of the file into the preamble

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Relax the header regex to allow a trailing comment: `/^\s*\[([^\]]+)\]\s*(?:#.*)?$/`. Cheap, and it removes an entire class of misclassification.

The regex is `/^\s*\[([^\]]+)\]\s*$/`. Verified: `model="x"\n\n[tui]  # theme\ntheme="a"\n\n[projects.a] # trust\ntrust_level="t"\n` yields `shared: []`, `local: []`, and a head containing the *entire file* including `[projects.a]`. Two bad outcomes in one: (1) a human writing `[tui] # my theme` causes everything after it to be lumped into the preamble, so any Codex-appended machine state below leaks verbatim into the cloud payload — absolute per-host paths shared to every machine, the exact pollution the split exists to stop; (2) the head is no longer separable, so the sectioning silently degrades to a pass-through with no signal.

---

### [SR-20260829-030] [LOW] scripts/setup/setup.js — None of the risky new code paths are tested — the two new test files cover only the pure helpers, and setup.test.mjs still does not exist

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add scripts/setup/setup.test.mjs with tmpdir fixtures for: composeCodexConfigFile against (a) a real non-symlink ~/.codex/config.toml, (b) a symlink, (c) an absent payload, (d) twice in a row for idempotency; adoptSyncDir with a pre-existing destination file and with a rename failure; the four-way seedTemplates truth table including the partial-payload case; linkSourceRoot for base:'sync' vs unmarked. This requires the setup(opts) refactor above, which is a further argument for it.

121 tests pass, but `codex-config-compose.test.mjs` exercises only `splitCodexConfig`/`sharedHeadOf`/`composeCodexConfig` on well-formed input (its one adversarial case, the unterminated marker block, is the least dangerous one), and `sync-dir.test.mjs` covers only the resolution precedence table — the obviously-correct part, which is precisely what SR-20260829-030 predicted would happen. Everything that touches the filesystem destructively — `composeCodexConfigFile` (rewrites a cloud file and ~/.codex/config.toml), `adoptSyncDir` (moves user data), the seeding guard, `linkSourceRoot` — has zero coverage. The migrate.test.mjs additions are the exception and are genuinely good: the base:'sync' and dangling-link cases are real regression guards.

---

### [SR-20260829-031] [LOW] scripts/setup/setup.js — regenerateCodexArtifacts still builds the providers block only to hand it to injectModelProviders(null), which discards it; the block is then generated a second time in composeCodexConfigFile

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Give regenerateCodexArtifacts a `models`-only mode (or call `generateModelsCatalog` directly) and drop the null-path escape hatch from injectModelProviders. Then compose can be the single owner of the providers block, with one generation per run. Also delete or fix the now-false comment block above the call, which still describes marker injection into codex_config.toml.

`regenerateCodexArtifacts({ codexConfigPath: null, ... })` generates the provider block, passes it to `injectModelProviders`, which returns `{status:'no-config'}` and drops it on the floor. `composeCodexConfigFile` then calls `generateModelProvidersBlock` again, and round-trips its output back through `splitCodexConfig` just to strip the markers that `composeCodexConfig` immediately re-adds — a generate/parse/re-emit cycle to move a string. `artifacts.providers` is now dead: the three log branches that consumed it were deleted, and nothing else reads it. Meanwhile the 12-line comment above the call still says "the [model_providers.*] section of codex_config.toml (only when that file exists) ... The generated section lives between two setup-managed markers; user edits above the markers are preserved verbatim", which is no longer true of this call site at all.

---

### [SR-20260829-032] [INFO] scripts/setup/setup.js — setup.js is at 600 lines and now mixes symlink management, destructive user-data migration, and TOML composition in one module

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move `composeCodexConfigFile` into codex-config-compose.mjs (it is the only I/O-aware function of that concern and the pure helpers already live there) and `adoptSyncDir` + `expandHome` into scripts/shared/sync-dir.mjs (which already exports `expandTilde` — `expandHome` in setup.js is a byte-for-byte duplicate of it). That drops setup.js by ~90 lines, removes the duplicate, and makes both functions testable without importing the whole link machinery.

The repo's own guidance flags >300 lines for scrutiny; setup.js is 600 and this commit added 217. It now owns: OS detection, the link tables, linkEntry's careful backup/restore protocol, cc-market git operations, alias installation, sync-dir adoption (moves files), and Codex TOML composition (rewrites two files). `expandHome(p, home)` at the bottom of setup.js is an exact reimplementation of `expandTilde(p, home)` already exported from sync-dir.mjs and imported into the same file — two copies of the same three-line function, only one of which is tested.

---

### [SR-20260829-033] [INFO] scripts/runtime/cc.js — Launchers now hard-depend on ~/.claude/claude_env_settings.json existing, so ccc/cods fail before the first setup run where the repo-relative path used to work

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Fall back to `resolveSyncDir({repoRoot})` (or the repo path) when the link is absent, or emit a one-line 'run npm run setup first' message instead of whatever readMergedEnvSettings does with ENOENT.

Switching to `join(homedir(), '.claude', 'claude_env_settings.json')` is the right call — it is what SR-20260829-027 asked for and it keeps resolveSyncDir out of the hot path. The cost, unmentioned in the comment: the old repo-relative path worked on a fresh clone before setup had ever run, and the new one does not. Combined with `linkEntry`'s silent `skip: source not found` when the payload has not synced yet, a user can end up with no link and a launcher that fails on a missing file with no hint that setup is the fix. Related doc drift: `scripts/shared/config.mjs` line 3 still asserts "claude_env_settings.json rides the OneDrive-synced repo, so every machine sees the same file", which this commit made false.
