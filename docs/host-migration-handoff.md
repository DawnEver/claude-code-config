# Handoff — set this workstation up on the new layout

**For:** G and WS1 (`duip622037`). The macOS host is done.
**Date:** 2026-08-29 · **Repos:** `DawnEver/claude-code-config` and `DawnEver/ai-agents`

Hand this file to a person, or paste it whole into a Claude Code session. It is
self-contained — no context from the originating session is needed.

---

## 0. What changed, and why your checkout looked broken

The working trees used to live at `<OneDrive>/Sync/claude/` and `<OneDrive>/Sync/agents/`,
so **OneDrive was replicating `.git/`**. Git assumes it owns `.git/` exclusively on one
machine; a sync daemon writing into it from another machine corrupts it silently.

That is what "claude-config doesn't sync in time" / "my changes vanished" / "git says a
hundred files are modified and I didn't touch them" actually were. Confirmed damage:

| Evidence | Meaning |
| --- | --- |
| `.git/index-G`, `index-<hostname>`, `FETCH_HEAD-<hostname>-1..6` | OneDrive conflict copies of the index and `FETCH_HEAD` |
| `.git/logs/HEAD` frozen at Aug 7 while commits ran to Aug 27 | **the reflog was overwritten — git's undo history is gone** |
| `main` 11 behind `origin/main`, tree at `+1111 / −4106` | the checkout was a stale partial replica; committing it would have deleted ~4100 published lines |
| `ai-agents` index: 393 entries against 284 real files | `reviewer-discovery/` reported untracked while present on the remote; three committed memory files reported as staged deletions |

Both repos were verified against GitHub — **0 unpushed commits, 0 files holding unique
work** — and the old trees have been deleted. Nothing was lost.

## 1. The new layout

```
~/Documents/Code/AI/            ← git working trees, NEVER cloud-synced
  cc-config/
  ai-agents/

<OneDrive>/Sync/                ← sync + backup only; NO .git anywhere
  cc-config/     72K   the 3-file config payload + this tooling
  agent-data/   215M   bulk data that is deliberately not in git
```

Three kinds of thing used to share one folder and one mechanism. They are now separated by
what they actually need:

| | Needs | Lives in | Transport |
| --- | --- | --- | --- |
| working trees | exclusive `.git` | `~/Documents/Code/AI/` | git |
| small shared config | cross-machine sync | `<OneDrive>/Sync/cc-config/` | cloud |
| bulk local-only data | backup | `<OneDrive>/Sync/agent-data/` | cloud |

**The invariant to keep: no `.git` directory anywhere under `Sync/`.**

## 2. First — is your old tree still there?

The deletion happened on the macOS host and propagates through OneDrive. Depending on when
your client last synced, you are in one of two states:

```
ls "<OneDrive>/Sync"
```

- **Only `cc-config`, `agent-data`, `setup-no_admin.bat`** → the delete has arrived. Go to §3.
- **You still see `claude` and/or `agents`** → your client has not caught up, and those
  folders are about to disappear. If you have uncommitted work in them, salvage it now:

  ```
  cd "<OneDrive>/Sync/cc-config"
  node rescue-clone.mjs
  ```

  It prints `SAFE` or `STOP` per repo. `STOP` means push what it names before the delete
  lands. This already ran from macOS and returned SAFE for both repos — so a `STOP` here
  means *your* machine holds something macOS could not see. That is exactly what it is for.

  > **Why not just `git status`?** In a cloud-corrupted clone it lies four ways: a stale
  > `HEAD` reports published content as "modified"; Files-On-Demand placeholders make it
  > exit 128 with **no output at all**; CRLF vs LF makes every Windows-written file look
  > modified; and it only looks at the checked-out branch. `rescue-clone.mjs` asks the only
  > honest question — *does this content exist anywhere in the published history?* — by
  > hashing each file and looking the blob up in a reference clone. On macOS the
  > branch check was the one that mattered: it found three local branches in `cc-market`
  > that a checked-out-branch-only check had reported clean.

### Before you go further: pin the folders

Right-click `<OneDrive>/Sync/cc-config` and `<OneDrive>/Sync/agent-data` → **"Always keep
on this device"**, and wait for the download. A dehydrated file satisfies `existsSync` but
blocks on first read, and the launchers read `claude_env_settings.json` on **every**
invocation.

## 3. Set up

```
git clone https://github.com/DawnEver/claude-code-config.git ~/Documents/Code/AI/cc-config
git clone https://github.com/DawnEver/ai-agents.git          ~/Documents/Code/AI/ai-agents

cd ~/Documents/Code/AI/cc-config
node scripts/setup/setup.js --sync-dir "<OneDrive>/Sync/cc-config" --replace

cd ~/Documents/Code/AI/ai-agents
./scripts/link-agent-data.sh
```

Windows: `%USERPROFILE%\Documents\Code\AI\...`. Any non-cloud path works; never a synced folder.

`setup.js` records `~/.claude/sync-dir`, links `~/.claude` and `~/.codex` at the repo and
the payload, and composes `~/.codex/config.toml`. `link-agent-data.sh` recreates six
gitignored symlinks into `agent-data/`; it resolves that directory from an argument,
`$AGENT_DATA_DIR`, or the `sync-dir` pointer's sibling, so it works under either username.

## 4. Verify

- [ ] `~/.claude/sync-dir` holds the payload path.
- [ ] `~/.claude/claude_env_settings.local.json` has **this host's API keys**. Machine-local,
      never synced — if missing, `ccds` / `cckm` / `cods` fail. Add them **there**, never in
      the shared file.
- [ ] `~/.codex/config.toml` is a **real file**, not a symlink, with your own `[projects.*]`
      plus a `# === setup-managed: model_providers ===` block.
- [ ] `npm test` in `cc-config` passes — **151 tests**.
- [ ] `node scripts/setup/setup.js` prints `0 errors` and exits 0.
- [ ] `ccc`, `ccds`, `cods` start.
- [ ] `git status` in `ai-agents` is clean (the data symlinks are gitignored).
- [ ] No symlink under `~/.claude` / `~/.codex` dangles — `npm run migrate` cleans leftovers,
      including the `.setup-bak` links that `--replace` leaves behind.

## 5. Windows gotchas

- **Symlink privilege.** Windows grants file symlinks only with Developer Mode on or an
  elevated shell. Otherwise setup falls back to **hard links**, which break whenever a
  writer *replaces* the file — and `git checkout` is exactly such a writer. If you see
  `EPERM` hints, enable Developer Mode and re-run with `--replace`.
- **Hard links cannot cross volumes** (`EXDEV`). Cloning to `D:` while `~/.claude` is on
  `C:` breaks the hard-link fallback for `claude_plugins/claude-hud/config.json`.
- **Alias install may need elevation.** On macOS the `cods`/`cogmi` wrappers wanted
  `/usr/local/bin` and hit `EACCES`.

## 6. Do NOT

- **Do not put a git working tree back in cloud storage.** That is the entire bug.
- **Do not add `[projects.*]`, `[hooks.state.*]` or `[notice]` to the payload's
  `codex_config.toml`.** Codex writes those per machine with absolute paths — the live file
  had **30**, spanning two usernames and three drive letters. `~/.codex/config.toml` is
  *composed* per host, not linked; setup strips machine state out of the payload on every
  run, so anything you add there silently disappears.
- **Do not put API keys in `claude_env_settings.json`.** Machine-local file only.
- **Do not commit anything under `agent-data/`.** It is out of git on purpose — size, and
  `cc-docx/workspace` holds real contact emails and partner names.

## 7. If something is missing

The old trees were deleted from OneDrive on 2026-08-29, after both repos verified `SAFE`.
If something is genuinely gone, OneDrive's **web recycle bin** keeps deleted items for
about 30 days — look there first.

Two known gaps, both low risk but worth stating:

- **122 files under `cc-market/cc-academia/`** were placeholders on the macOS host and could
  not be verified there. They are tracked files whose committed content is on GitHub; only
  an *uncommitted* edit made on your machine would have been at risk.
- **Three `cc-market` branches** (`backup/pre-tidy-substrate-observe-proxy`,
  `feat/substrate-observe-proxy`, `fix/cc-academia-ci`) held 13 commits from 2026-07-08 that
  were never pushed. They were judged superseded: they built the fabric plugin, which has
  been in `main` and under active development ever since (119 files, last touched 2026-08-26).
  They were not preserved.

## 8. Report back

- `rescue-clone.mjs` printing `STOP`
- setup output containing `ERR`, `EPERM` or `EXDEV`
- a launcher that cannot find its provider or API key
- `npm test` failing

`git pull` in `~/Documents/Code/AI/cc-config` before reporting a bug — fixes land there.
