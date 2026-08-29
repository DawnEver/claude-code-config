# Handoff — migrate this workstation off the OneDrive working tree

**For:** G and WS1 (`duip622037`). The macOS host is done.
**Date:** 2026-08-29 · **Repo:** `DawnEver/claude-code-config`, `main` at `c020363` or later

Hand this file to a person, or paste it whole into a Claude Code session on the target
machine. It is self-contained — no context from the originating session is needed.

> **If you only read one thing:** do **not** try to fix the OneDrive checkout in place.
> Run Phase 0 (salvage) before anything else — it is the only step that can lose work, and
> `git status` cannot be trusted to tell you whether you have any.

---

## 0. The symptom you are seeing

"claude-config doesn't sync in time" / "my checkout is behind" / "my changes vanished" /
"git says a hundred files are modified and I didn't touch them".

None of these are sync-latency problems. They are all the same underlying fault.

### What is actually happening

The working tree lives at `<OneDrive>/Sync/claude/`, so **OneDrive is replicating `.git/`**.
Git assumes it owns `.git/` exclusively on one machine. A sync daemon writing into it from
another machine breaks that assumption, and the damage compounds silently.

Confirmed on the macOS host:

| Evidence | Meaning |
| --- | --- |
| `.git/index-G`, `index-<hostname>`, `index-<hostname>-2` | OneDrive conflict copies of the git **index** |
| `.git/FETCH_HEAD-G`, `FETCH_HEAD-<hostname>-1..6` | same for `FETCH_HEAD` |
| `.git/logs/HEAD` stuck at Aug 7 while commits ran to Aug 27, plus `logs/HEAD-G` | **the reflog was overwritten — git's undo history is gone** |
| `origin/main-G` on GitHub | a host pushed a divergent branch instead of merging |
| local `main` 11 behind `origin/main`, working tree at `+1111 / −4106` vs origin | the checkout was a stale partial replica, not new work — committing it would have deleted ~4100 published lines |
| `git status` in `cc-market` exits 128 with `read error while indexing …: Operation timed out` | Files-On-Demand placeholders git cannot read |

So "behind" is not latency. Your `.git` and your files are updated by two mechanisms that
do not coordinate: git updates `.git` when you run commands, OneDrive updates the files
whenever another machine touches them. They drift apart, and neither notices.

### The fix

The working tree moves **out** of cloud storage and travels via GitHub. OneDrive keeps only
a three-file config payload — small, hand-edited files it handles correctly.

Full design and reasoning: `docs/sync-architecture.md` in the repo.

---

## 1. Phase 0 — SALVAGE (first, and the only lossy step)

### Why `git status` cannot answer "do I have unsaved work?"

In a cloud-corrupted clone it lies in **four** distinct ways:

1. **`.git/HEAD` is stale.** OneDrive synced newer *published* content down from another
   machine while your `.git` still points at an old commit, so `git status` reports dozens
   of "modified" files that are simply later commits' content.
2. **Placeholders abort it entirely.** A file this host never downloaded satisfies
   `existsSync` but cannot be read; `git status` exits 128 and prints **nothing**. A
   clean-looking failure that reads as "no changes".
3. **CRLF vs LF.** Files written by a Windows host differ from a Unix checkout on every
   line. All of them look modified.
4. **It only looks at the checked-out branch.** Work on another local branch is invisible.

On the macOS host #4 was the one that mattered. After everything else came back clean,
`cc-market` turned out to have **three local branches with unpushed commits** — 13 of them,
from 2026-07-08, whose subjects appear nowhere in the published history:

```
backup/pre-tidy-substrate-observe-proxy   13 commits ahead
feat/substrate-observe-proxy               1 commit ahead
fix/cc-academia-ci                         tip object unreadable (mmap failed)
```

That is the entire reason this phase exists. **Assume you have some too.**

### Before you run anything: pin the folders

Right-click `<OneDrive>/Sync/claude` **and** `<OneDrive>/Sync/cc-config` → **"Always
keep on this device"**, and wait for the download to finish.

A placeholder is the one class of file no tool can verify from a host that never downloaded
it — and if a placeholder holds *your* uncommitted edit, only *your* machine can see it.

### Run the salvage tool

```
cd "<OneDrive>/Sync/cc-config"
node rescue-clone.mjs
```

It checks **both** repos — `cc-config` and `cc-market` — and for each:

- lists unpushed commits on the checked-out branch (reads `.git` only, so placeholders
  cannot hide them);
- finds every local branch whose tip is not on the remote and **fetches those branches out
  of the damaged clone into your healthy one** as `rescue/<branch>` — copying objects to
  safety rather than analysing them in place;
- asks of every tracked file the only honest question — *does this content exist anywhere
  in the published history?* — by hashing it and looking the blob up in a reference clone,
  trying raw bytes and both line-ending normalisations;
- detects Files-On-Demand placeholders with `stat` (`blocks === 0 && size > 0`) instead of
  reading them, turning a multi-minute hang into an instant check;
- prints `SAFE` or `STOP` per repo.

**A `STOP` means do not delete that folder.** Inspect and publish what it names:

```
git -C "<old path>" log --oneline @{u}..HEAD
git -C "<old path>" push origin HEAD:refs/heads/rescue-<repo>-<hostname>
```

Rescued branches land in your new clone; review and publish them at leisure:

```
git -C ~/Documents/Code/AI/cc-config/cc-market log --oneline origin/main..rescue/<branch>
git -C ~/Documents/Code/AI/cc-config/cc-market push origin rescue/<branch>
```

---

## 2. Phase 1 — migrate

```
cd "<OneDrive>/Sync/cc-config"
node migrate-host.mjs --dry-run
node migrate-host.mjs
```

Default clone target is `~/Documents/Code/AI/cc-config`
(`%USERPROFILE%\Documents\Code\AI\cc-config` on Windows). Override with
`--target "D:\dev\cc-config"` — any **non-cloud** path; the script refuses anything
containing `OneDrive`, `Dropbox`, `CloudStorage`, `iCloud`, `Google Drive`.

The script locates the payload and the old tree **relative to itself**, so it needs no
per-machine configuration despite the fleet's mixed usernames (`linxu` / `ezxmb14`) and
mixed OS.

What it does: verify node/git → **read** all three payload files (not merely `stat` them) →
report unpushed work in the old tree → clone → `setup.js --sync-dir <payload> --replace` →
verify → run the cc-market salvage pass.

### What "the payload" is

| Tier | What | Where | Transport |
| --- | --- | --- | --- |
| A | scripts, skills, prompts, templates, memory, docs | the repo | **git** |
| B | `claude_settings.json`, `claude_env_settings.json`, `codex_config.toml` (**head only**) | `<OneDrive>/Sync/cc-config/` | **OneDrive** |
| C | `claude_env_settings.local.json` (**all API keys**), `sync-dir` pointer | `~/.claude/` | never synced |
| D | `models.json`, `codex_config.toml`'s `[model_providers.*]`, `system-prompt/dist/` | generated | rebuilt per machine |

`resolveSyncDir()` order: `$CLAUDE_SYNC_DIR` → `~/.claude/sync-dir` pointer file → **repo
root**. The repo-root fallback keeps a no-cloud install zero-config; there is deliberately
no cloud auto-detection (this repo is public, and Dropbox/iCloud/Syncthing/nothing are all
valid).

---

## 2b. The OTHER repo — `ai-agents`

`<OneDrive>/Sync/agents` had the same disease and gets the same treatment. On the macOS
host its index held 393 entries against 284 real files, reported `reviewer-discovery/` as
untracked and three committed memory files as staged deletions — **all present on the
remote**. Verified `SAFE`: 0 unpushed commits, 0 orphans.

```
cd "<OneDrive>/Sync/cc-config"
node rescue-clone.mjs --old "<OneDrive>/Sync/agents" \
  --repo https://github.com/DawnEver/ai-agents.git \
  --new ~/Documents/Code/AI/ai-agents
```

If `SAFE`, clone it and relink its bulk data:

```
git clone https://github.com/DawnEver/ai-agents.git ~/Documents/Code/AI/ai-agents
cd ~/Documents/Code/AI/ai-agents
./scripts/link-agent-data.sh
```

### Why that repo needs a second step

Most of what lived under `Sync/agents` was never in git and never will be — 215M of
archives plus the PII-bearing `cc-docx/workspace`. That data wants **backup**, not version
control, so it now lives at `<OneDrive>/Sync/agent-data/` and is joined back to the working
tree by six gitignored symlinks. `link-agent-data.sh` recreates them; it resolves the data
dir from an argument, `$AGENT_DATA_DIR`, or the `~/.claude/sync-dir` payload's sibling.

Dropped on purpose, not moved: `literature-review/ongoing` (668M of re-downloadable
papers) and `cc-lab/node_modules`.

**This is the general principle of the restructure:** `Sync/` used to hold three things
with incompatible needs — git working trees, small shared config, and large local-only
data — under one mechanism. They are now separated:

| | Lives in | Transport |
| --- | --- | --- |
| working trees | `~/Documents/Code/AI/` | git |
| config payload | `<OneDrive>/Sync/cc-config/` | cloud sync |
| bulk data | `<OneDrive>/Sync/agent-data/` | cloud sync (backup) |

No `.git` directory exists anywhere under `Sync/` any more. That is the invariant to keep.

---

## 3. Phase 2 — verify before calling it done

- [ ] `~/.claude/sync-dir` holds the payload path (the script checks this).
- [ ] `~/.claude/claude_env_settings.local.json` still has **this host's API keys**.
      Machine-local, never synced — if missing or empty, `ccds` / `cckm` / `cods` will fail.
      Re-add them **there**, never in the shared file.
- [ ] No symlink under `~/.claude` or `~/.codex` still resolves into `<OneDrive>/Sync/claude`
      (the script lists any; `npm run migrate` cleans them, including dangling ones).
- [ ] `~/.codex/config.toml` is a **real file**, not a symlink, and contains your own
      `[projects.*]` entries plus a `# === setup-managed: model_providers ===` block.
- [ ] `ccc`, `ccds`, `cods` all start.
- [ ] `npm test` in the repo passes — **151 tests**.
- [ ] `node scripts/setup/setup.js` prints `0 errors` and exits 0.

---

## 4. Windows-specific gotchas

- **Symlink privilege.** `setup.js` creates file symlinks; Windows grants these only with
  Developer Mode on or an elevated shell. Otherwise it falls back to **hard links**, which
  break whenever a writer *replaces* the file — and `git checkout` is exactly such a writer.
  If you see `EPERM` hints, enable Developer Mode and re-run with `--replace`.
- **Hard links cannot cross volumes** (`EXDEV`). Cloning to `D:` while `~/.claude` is on
  `C:` breaks the hard-link fallback for `claude_plugins/claude-hud/config.json`. Prefer a
  target on the same drive as your user profile.
- **Files-On-Demand.** See Phase 0 — pin both folders first. The launchers read
  `claude_env_settings.json` on **every** invocation; a dehydrated file makes that block.
- **Alias install may need elevation.** On macOS the `cods`/`cogmi` wrappers wanted
  `/usr/local/bin` and hit `EACCES`. Either run once elevated or put the target bin dir on
  PATH.

---

## 5. Do NOT

- **Do not put a git working tree back in cloud storage.** That is the entire bug.
- **Do not delete `<OneDrive>/Sync/claude` until Phase 0 returns `SAFE` on every host.**
  It is the rollback, and it may hold another machine's only copy of something.
- **Do not add `[projects.*]`, `[hooks.state.*]` or `[notice]` to the payload's
  `codex_config.toml`.** Codex writes those itself, per machine, with absolute paths — the
  live file had **30** of them across two usernames and three drive letters.
  `~/.codex/config.toml` is **composed** per host (shared head + generated providers + your
  own state), not linked. Setup strips machine state out of the payload on every run, so
  anything you add there silently disappears.
- **Do not put API keys in `claude_env_settings.json`.** Tier C file only.
- **Do not run `git` inside `<OneDrive>/Sync/claude` once you have migrated** — especially
  not setup, which does `git pull` inside `cc-market`.

---

## 6. Phase 3 — teardown, only when every host is done

```
node rescue-clone.mjs            # must print SAFE for both repos
node rescue-clone.mjs --delete   # removes cc-market first, then the config repo
```

Order matters: `cc-market` is nested inside the config repo, and `setup.js` pulls inside it
on every run. The tool deletes deepest-first and refuses to touch anything not `SAFE`.

---

## 7. Rollback

Nothing is destroyed by Phases 1–2. To revert one host: delete `~/.claude/sync-dir`, then
re-run `node scripts/setup/setup.js --replace` from `<OneDrive>/Sync/claude`. The payload
files were **copied**, not moved, so the old tree still has its own copies.

---

## 8. What changed in the repo (for review)

| Commit | What |
| --- | --- |
| `e38fc43` | the split: `sync-dir.mjs`, `base:'sync'` link entries, `--sync-dir`, codex config three-way split |
| `adb3d33` | 18 findings from an adversarial review, incl. a real data-loss path in the codex TOML splitter |
| `c020363` | memory entries + the crystallized `path-conventions.md` rule |

Two behaviour changes worth knowing:

- **`~/.codex/config.toml` is no longer a symlink** — it is composed. Your project-trust
  entries survive regeneration if their paths still exist here; other machines' dead paths
  are dropped.
- **Launchers read `~/.claude/claude_env_settings.json`**, falling back to the repo-relative
  path before the first setup run.

Also fixed, because it will bite you otherwise: `claude_env_settings.json` is gitignored, so
the `providers.<name>` refactor never propagated through git. The macOS copy was still the
old `env:*` shape while the code required the new one, and `models.json` generated empty.
It has been rebuilt from the tracked template with the `fabric` block preserved; the old
shape is kept at `claude_env_settings.json.pre-providers-bak`. **If `cods` reports no
models after migrating, that is what happened — check the payload's shape.**

---

## 9. Report back

Tell the macOS host if you hit any of:

- `rescue-clone.mjs` printing `STOP`, or naming a branch it could not fetch
- setup output containing `ERR`, `EPERM` or `EXDEV`
- a launcher that cannot find its provider or API key
- `~/.codex/config.toml` losing your project trust entries
- `npm test` failing

Run `git pull` in `~/Documents/Code/AI/cc-config` before reporting a bug — fixes land there.
