# Read me first

This folder is the **sync payload** for `claude-code-config`. It holds only the three
hand-edited config files that have to reach every machine:

| File | What it is |
| --- | --- |
| `claude_settings.json` | Claude Code env vars, permissions, hook wiring |
| `claude_env_settings.json` | provider registry (base URLs, model pins). **No API keys** |
| `codex_config.toml` | Codex config — **hand-edited head only** |

Everything else — scripts, skills, prompts, memory — travels via GitHub
(`DawnEver/claude-code-config`). The git working tree deliberately does **not** live in
OneDrive any more.

## Why

The working tree used to sit at `../claude`. OneDrive replicated `.git/` between
machines, which produced conflict copies of `.git/index` and `.git/FETCH_HEAD`,
overwrote `.git/logs/HEAD` (destroying the reflog), and left a divergent `main-G`
branch on GitHub. Git assumes it owns `.git/` exclusively on one machine; a file-sync
daemon breaks that assumption. Three small hand-edited files are a workload OneDrive
*does* handle correctly — a `.git` directory is not.

Full reasoning: `docs/sync-architecture.md` in the repo.

## Migrating a machine

On each host that has not been migrated yet:

```
node migrate-host.mjs --dry-run     # inspect first
node migrate-host.mjs               # do it
```

Optional: `--target <path>` to clone somewhere other than `~/Projects/claude-config`.

The script locates the payload and the old tree relative to itself, so it needs no
per-machine configuration — it works across the fleet's mixed usernames (`linxu`,
`ezxmb14`) and mixed OS. It will:

1. Check node/git, and **read** all three payload files — a OneDrive Files-On-Demand
   placeholder passes `existsSync` but fails on read, and migrating against a
   half-downloaded payload is the most likely way this goes wrong.
2. Refuse a target path inside any cloud-synced folder.
3. Report unpushed work in the old tree **and in `../claude/cc-market`** before anything
   is changed.
4. Clone the repo and run `setup.js --sync-dir <this folder> --replace`.
5. Verify the pointer, confirm this host's API keys survived, and list any link still
   resolving into the old tree.

Nothing in the old folder is deleted. It stays as the rollback.

## Do not

- **Do not put a git working tree back in OneDrive.** That is the bug.
- **Do not hand-edit `codex_config.toml` here to add `[projects.*]`, `[hooks.*]` or
  `[notice]`.** Codex writes those per machine; setup strips them from this file on
  every run. `~/.codex/config.toml` is composed per host, not linked to this one.
- **Do not put API keys in `claude_env_settings.json`.** They belong in each machine's
  own `~/.claude/claude_env_settings.local.json`, which never syncs.

## Teardown

`cc-market` is a separate repo that setup clones into the working tree, so it migrates
along with it. The OLD copy at `../claude/cc-market` still needs removing — setup runs
`git pull` inside it, which is git-inside-cloud-storage all over again.

Do not trust `git status` there: its `.git` was cloud-replicated, placeholders make it
abort, and CRLF/LF differences make every Windows-written file look modified. Use:

```
node rescue-clone.mjs              # verdict only
node rescue-clone.mjs --delete     # remove it, if SAFE
```

It hashes every tracked file and looks the blob up in the published history, so it
distinguishes real unpublished work from stale cloud sync. Run it on the host that can
actually READ the files in question — a placeholder can only be checked where it is real.

Order: `../claude/cc-market` first, then `../claude`.
