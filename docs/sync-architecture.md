# Sync Architecture

How this repo's files get from one machine to another, and why the working tree no
longer lives inside a cloud-synced folder.

## 1. The failure this design replaces

Until 2026-08-29 the git working tree itself lived at
`<OneDrive>/Sync/claude/`. OneDrive replicated `.git/` along with everything else.
Git assumes it owns `.git/` exclusively on the local machine; a file-sync daemon
replicating it from another host violates that assumption.

Observed damage on the macOS host:

| Artifact | Meaning |
| --- | --- |
| `.git/index-G`, `index-G-2`, `index-Linxu's MacBook Air`, `-2` | OneDrive conflict copies of the git index |
| `.git/FETCH_HEAD-G`, `-G-2`, `FETCH_HEAD-Linxu's MacBook Air-1..6` | conflict copies of `FETCH_HEAD` |
| `.git/logs/HEAD` frozen at 2026-08-07 while commits ran to 08-27, plus `logs/HEAD-G` | **the reflog was overwritten — git's undo history was gone** |
| `origin/main-G` on GitHub | a host pushed a divergent branch instead of merging |
| local `main` 11 commits behind `origin/main`, working tree at `+1111/-4106` vs origin | the local tree was a stale partial replica, not new work |

Root cause is not git and not OneDrive individually: it is **two writers against one
non-atomically-replicated directory**. No amount of care in git usage fixes it.

Corollary: a bare repo inside OneDrive (a common suggested workaround) is unnecessary
here — this repo already has a real remote, `github.com/DawnEver/claude-code-config`.
GitHub *is* the compact-packfile remote that idea is reaching for.

## 2. Goals and constraints

1. `.git/` and the working tree are never touched by a file-sync daemon.
2. A handful of hand-written config files still need to reach every machine — those
   are gitignored because they are host-tuned and, historically, secret-bearing.
3. **Not every user of this repo has OneDrive**, or any cloud sync at all. This repo is
   public. The zero-config default must be a plain single-machine install that behaves
   exactly as it does today.
4. No absolute cloud path may appear in any shared or tracked file. The fleet has mixed
   usernames (`linxu` on G/WS2, `ezxmb14` on WS1) and mixed OS. This is the same
   constraint that produced the `~/.claude/system-prompt` convention — see
   `.claude/memory/2026/08/11/system-prompt-paths-symlink.md`.
5. Secrets must not enter the cloud payload or git.

## 3. File classification

Every file in the install belongs to exactly one of four tiers. Getting this split
right is most of the design; it shrinks the cloud payload from "the whole repo" to
three files.

### Tier A — tracked in git, synced via GitHub

Everything under `scripts/`, `skills/`, `output-styles/`, `system-prompt/`,
`claude_plugins/`, `.claude/rules/`, `.claude/memory/`, `docs/`, all `*.template.*`
files, `GLOBAL-AGENTS.md`, `keybindings.json`, `AGENTS.md`, `README.md`.

Transport: `git pull` / `git push`. Nothing else.

### Tier B — the sync payload (3 files)

| File | Why it can't be in git | Why it must be shared |
| --- | --- | --- |
| `claude_settings.json` | env vars, permissions, hook wiring — historically secret-bearing | one settings surface across machines |
| `claude_env_settings.json` | non-secret provider config (base URLs, model pins) | `providers.<name>` is the single source of truth for both `cc*` and `co*` launchers |
| `codex_config.toml` | host-tuned Codex config (model, sandbox, TUI) | same — **but only its hand-edited head**, see below |

These are small, hand-edited, rarely written concurrently, and contain no `.git`, no
locks, and no atomic-rename storms. This is a workload a file-sync daemon actually
handles correctly. **This is the only thing the cloud folder is responsible for.**

#### `codex_config.toml` is not one file, it is three

The obvious classification — "a config file, therefore hand-edited, therefore Tier B" —
is wrong, and a review caught it before this shipped. Codex *writes to this file itself*:
it appends a `[projects.'<absolute path>']` trust block on every new project directory it
visits, plus `[hooks.state.*]` and `[notice]` runtime state. The live file held **30
project blocks spanning two usernames (`linxu`, `ezxmb14`) and three drive letters**,
alongside 21 Windows and 4 macOS absolute paths.

Cloud-syncing that whole file would reproduce the exact two-writers problem this design
exists to eliminate — just at lower frequency — and would pollute every host with the
other hosts' dead paths forever. So the file is split by owner:

| Part | Owner | Where it lives |
| --- | --- | --- |
| preamble + `[tui]`, `[plugins.*]`, `[features]`, … | human | **Tier B**, the sync payload |
| `[model_providers.*]` between the setup-managed markers | `claude_env_settings.json` | Tier D, regenerated |
| `[projects.*]`, `[hooks.*]`, `[notice]` | Codex itself | **Tier C**, machine-only |

`~/.codex/config.toml` is therefore **a real file composed per host**, not a symlink into
the payload: shared head + generated providers block + this host's own state. Splitting
the live 198-line file yielded an 82-line shared head — exactly the section set the
tracked template already declares — and 39 machine-local sections that stop travelling.
`sharedHeadOf()` is idempotent and also runs against the payload on every setup, so state
that leaked in from an older host gets stripped rather than shared.

See `scripts/setup/codex-config-compose.mjs`.

### Tier C — machine-local, never synced

| File | Contents |
| --- | --- |
| `~/.claude/claude_env_settings.local.json` | **all API keys**, per-host overrides |
| `~/.claude/sync-dir` | pointer to this machine's sync directory (see §4) |
| `~/.claude/settings.local.json`, `.claude/rules/MEMORY.md`, `_meta.json` | per-device generated/local state |

`~/.claude` is a real per-machine directory; only specific children are links into the
repo. Nothing here crosses machines, by construction. Keys therefore never enter the
cloud payload **or** git.

### Tier D — generated, never synced

| File | Generated from | By |
| --- | --- | --- |
| `models.json` | `claude_env_settings.json` → `providers.<name>.models` | `regenerateCodexArtifacts()` |
| `codex_config.toml`'s `[model_providers.*]` section (between the two setup-managed markers) | same | same |

Regenerated unconditionally on every `npm run setup`. `models.json` is therefore a
build artifact and drops out of the sync payload entirely — it lives in the repo dir,
gitignored, rebuilt per machine. (The hand-edited part of `codex_config.toml` above
the markers is Tier B; the generated part below them is Tier D. Same file, and the
marker protocol already keeps them separate.)

## 4. Resolving the sync directory

Only **one** component needs to know where the sync directory physically is:
`setup.js`. Everything else reaches Tier B files through the `~/.claude/…` and
`~/.codex/…` links that setup creates. This is the established convention — a shared
config never names a cloud path, it names `~/.claude/...` and lets the per-host link
resolve it.

New module `scripts/shared/sync-dir.mjs`:

```js
export function resolveSyncDir({ repoRoot, env = process.env, home = os.homedir() }) {
  // 1. explicit override — CI, tests, unusual layouts
  if (env.CLAUDE_SYNC_DIR) return expandTilde(env.CLAUDE_SYNC_DIR, home);

  // 2. machine-local pointer file: a single line holding a path.
  //    Not an env var, so it works for GUI-launched apps and non-login shells.
  const pointer = join(home, '.claude', 'sync-dir');
  if (existsSync(pointer)) {
    const p = readFileSync(pointer, 'utf8').trim();
    if (p) return expandTilde(p, home);
  }

  // 3. default: the repo itself. Zero-config, single-machine, no cloud storage.
  //    Identical to the pre-migration behaviour.
  return repoRoot;
}
```

Deliberately **no OneDrive auto-detection.** Guessing at `~/Library/CloudStorage/OneDrive-*`
would be wrong for Dropbox/iCloud/Syncthing users, ambiguous when several OneDrive
accounts are mounted, and silently surprising for someone who has OneDrive installed
but does not want their config in it. The pointer file makes the choice explicit and
auditable, and costs one command per machine.

Setup grows a flag to write it:

```
node scripts/setup/setup.js --sync-dir "<path>"
```

which (a) writes `~/.claude/sync-dir`, (b) creates the directory, and (c) **moves** any
Tier B file still sitting in the repo into it (never copies — two copies of
`claude_settings.json` is exactly the drift this migration removes).

## 5. Resulting topology

```
GitHub: DawnEver/claude-code-config
   │  git pull / push
   ▼
~/Projects/claude-config/            ← working tree + .git, NEVER cloud-synced
   ├── scripts/ skills/ system-prompt/ …      (Tier A)
   └── models.json                            (Tier D, generated, gitignored)

<cloud>/Sync/claude-config/          ← sync payload, 3 files, no .git   (Tier B)
   ├── claude_settings.json
   ├── claude_env_settings.json
   └── codex_config.toml

~/.claude/                           ← real per-machine dir
   ├── sync-dir                              (Tier C: points at the payload dir)
   ├── claude_env_settings.local.json        (Tier C: API keys)
   ├── settings.json              -> <cloud>/Sync/claude-config/claude_settings.json
   ├── claude_env_settings.json   -> <cloud>/Sync/claude-config/claude_env_settings.json
   ├── CLAUDE.md                  -> ~/Projects/claude-config/GLOBAL-AGENTS.md
   ├── skills/ scripts/ output-styles/ system-prompt/  -> ~/Projects/claude-config/…
   └── keybindings.json           -> ~/Projects/claude-config/keybindings.json

~/.codex/
   ├── config.toml                COMPOSED real file (shared head + generated + local)
   ├── models.json                -> ~/Projects/claude-config/models.json
   ├── AGENTS.md                  -> ~/Projects/claude-config/GLOBAL-AGENTS.md
   ├── system-prompt/             -> ~/Projects/claude-config/system-prompt
   └── skills/<name>/             -> ~/Projects/claude-config/skills/<name>  (per-skill)
```

With `resolveSyncDir()` returning the repo root (the no-cloud default), this collapses
to exactly today's layout — every link points into the repo. That is what makes the
change safe for public users.

## 6. Code changes

### `scripts/shared/sync-dir.mjs` (new)
`resolveSyncDir()`, `readSyncDirPointer()`, `writeSyncDirPointer()`, `expandTilde()`.
Pure and fully parameterized (`env`/`home` injectable) so it is testable without
touching the real `$HOME`.

### `scripts/setup/setup.js`
- Link tables gain a `base` field: `'repo'` (default) or `'sync'`.
  ```js
  { src: 'claude_settings.json', dest: 'settings.json', type: 'file', base: 'sync' },
  { src: 'claude_env_settings.json', dest: 'claude_env_settings.json', type: 'file', base: 'sync' },
  // CODEX_LINKS:
  { src: 'codex_config.toml', dest: 'config.toml', type: 'file', base: 'sync' },
  { src: 'models.json', dest: 'models.json', type: 'file' },   // stays repo-based (Tier D)
  ```
- `processLinks()` resolves `link.base === 'sync' ? syncDir : sourceDir`.
- The three "copy from template if absent" blocks target `syncDir` instead of `sourceDir`.
- `regenerateCodexArtifacts()` is already fully parameterized — it just receives
  `settingsPath`/`codexConfigPath` under `syncDir` and `modelsPath` under `sourceDir`.
- New `--sync-dir <path>` flag (writes pointer, creates dir, migrates Tier B files in).
- Startup banner prints the resolved sync dir, so a mis-set pointer is visible.

### `scripts/setup/check-links.js`
Has its **own** copy of the link loop and three hardcoded `path.join(sourceDir, …)` Tier B
paths. Missing it would have silently broken every SessionStart self-heal and every
`codex` launch: `linkEntry` would return `'source not found'` (which check-links filters
out of warnings) and `regenerateCodexArtifacts` would see `settings: 'missing'` and stay
quiet. Threaded through `linkSourceRoot()` + `getSyncDir()`, and it now also calls
`composeCodexConfigFile()` — `~/.codex/config.toml` is a composed file, so the link loop
cannot detect or repair it.

### `skills/migrate/migrate.js`
Two fixes:
- `migrateRetiredPlugins()` defaulted `settingsPath` to `sourceDir/claude_settings.json`
  and returned `[]` on a missing file, so after the move it would have become a permanent
  silent no-op that still printed "no retired plugin entries" — an actively false report.
  Now defaults to the resolved sync dir and logs a SKIP when absent.
- `findOrphanedLinks()` skipped any symlink whose `realpathSync` threw, i.e. every
  **dangling** link. Tier B links resolving outside the repo are correctly left alone, but
  the mirror case meant a link into a deleted location could never be cleaned. This was
  not hypothetical: `~/.claude/models.md` pointed at a file gone from both repos. Dangling
  links not in `goodDests` are now reported (ones still in `goodDests` are left for
  check-links to re-create).

### `scripts/runtime/cc.js` and `codex.js`
These do **not** need `resolveSyncDir`. `~/.claude/claude_env_settings.json` is already
the per-host indirection setup materializes for exactly this purpose, and §4's own rule
says a consumer should name `~/.claude/...` rather than re-derive a cloud path:
```js
-const envSettingsPath = join(__dirname, '..', '..', 'claude_env_settings.json');
+const envSettingsPath = join(homedir(), '.claude', 'claude_env_settings.json');
```
This keeps `resolveSyncDir`'s blast radius to `setup.js` and `check-links.js`, has no
bootstrap concern, and survives the repo moving again.

`cc-launcher.mjs` / `codex-launcher.mjs` need no change — they already take
`envSettingsPath` as a parameter, and `readMergedEnvSettings({sharedPath, localPath})`
already layers Tier C over Tier B.

### Seeding guard
The template-copy blocks now refuse to run when a sync dir is configured but empty —
that almost always means "the cloud client has not finished downloading", not "seed me".
Seeding would write desensitized templates into the shared folder, which the cloud client
then reconciles against the incoming real files: conflict copies of all three, with the
host running on template config in the meantime. `--init-sync-dir` is the explicit
override for the first machine. setup also warns when a Tier B file reappears in the repo
dir while a pointer is set, since gitignore guarantees git will never mention it.

### `.gitignore`
Tier B files leave the repo dir, so their entries become vestigial. They stay: a
no-cloud user (`syncDir === repoRoot`) still materializes them there.

### Docs
`AGENTS.md` §Architecture and `README.md` get the tier table and the `--sync-dir` step.

## 7. Tests

`scripts/shared/sync-dir.test.mjs` (auto-collected — `npm test` globs
`scripts/shared/*.test.mjs`):

- env var wins over pointer file wins over repo default
- `~` expansion in both env var and pointer file
- empty / whitespace-only pointer file falls through to the repo default
- missing pointer file → repo default (the public zero-config path)
- `writeSyncDirPointer()` is idempotent

`scripts/setup/setup.test.mjs`:
- `base: 'sync'` entries resolve under syncDir, unmarked entries under repoRoot
- with no pointer set, every resolved path is identical to the pre-change layout
  (this is the regression guard for public users)

## 8. Migration runbook

### This machine (macOS, done first)
1. `git clone https://github.com/DawnEver/claude-code-config.git ~/Projects/claude-config` ✅
2. Create `<OneDrive>/Sync/claude-config/`, **move** the 3 Tier B files there.
3. Implement §6 on the new clone; `npm test`; commit; push.
4. `node scripts/setup/setup.js --sync-dir "<OneDrive>/Sync/claude-config" --replace`
5. Verify every `~/.claude` / `~/.codex` link resolves to `~/Projects/claude-config`
   or `<OneDrive>/Sync/claude-config` — and **nothing** to `<OneDrive>/Sync/claude`.
6. Smoke-test `ccc`, `ccds`, `cods`, `todo`.

`<OneDrive>/Sync/claude/` is left in place for now, deliberately: it is the rollback
and it still holds the other machines' state until they migrate. It must be deleted
only after step 7 completes everywhere, because while it exists it keeps replicating a
poisoned `.git` between hosts.

### Each other machine (G, WS1/`duip622037`)
1. Let OneDrive settle, confirm `<OneDrive>/Sync/claude-config/` has arrived **with all
   three files**. Do not run setup against an empty payload dir — it now refuses, but
   check anyway.
2. `git clone … ~/Projects/claude-config` (Windows: any non-synced path).
3. `node scripts/setup/setup.js --sync-dir "<OneDrive>/Sync/claude-config" --replace`
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

## 9. Rollback

Nothing is destroyed until step 7. To revert: remove `~/.claude/sync-dir`, re-run
`setup.js --replace` from `<OneDrive>/Sync/claude`, and the old topology returns.
Tier B files are *moved*, so restore them from `<OneDrive>/Sync/claude-config/` if
rolling back before step 7.

## 10. Residual risks

- **Two hosts editing the same Tier B file between syncs** still produces an OneDrive
  conflict copy. Unlike an `.git/index` conflict this is visible, recoverable, and
  affects one small JSON file. Accepted.
- **A host that never migrates** keeps writing into `<OneDrive>/Sync/claude` and keeps
  the old breakage alive for itself. The runbook must be completed on all three.
- **Hard links.** `claude-hud`'s `config.json` must be a hard link (it rejects symlinked
  configs), and a hard link breaks when a writer *replaces* the inode. An earlier draft
  claimed this migration "strictly reduces" the exposure; that is **backwards**. The file
  is git-tracked, and this design makes `git pull` the primary transport for Tier A — so
  the breaking writer changes from "occasional cloud sync-down" to "every pull that
  touches this file". check-links auto-repairs it, but the honest fix is to ship
  `config.template.json` and gitignore the real one: a per-machine tuned file
  (`lineLayout`, `language`, `maxWidth`) should not be tracked at all. Not done here.

- **"No absolute cloud path in a shared file" is a goal, not a fact.** It holds for
  tracked files. It is currently **false for the payload**: `claude_env_settings.json`
  carries `"motronics-studio": "C:/Users/linxu/Documents/PEMC/motronics-studio"`, and the
  pre-split `codex_config.toml` was saturated with them. The codex split removes the
  largest source; the remaining one needs a `~`-relative value or a Tier C override. This
  design asserts the invariant but does not yet enforce it — a setup-time lint that greps
  the resolved payload for `/Users/`, `C:\`, `c:/` would.

- **Files-On-Demand placeholders.** A dehydrated cloud file satisfies `existsSync` but its
  first read can block on a network fetch or fail offline, and the launchers read
  `claude_env_settings.json` on the critical path of every `ccc`/`cods` invocation. Pin
  the sync folder to "Always keep on this device". Offline launch behaviour is untested.
