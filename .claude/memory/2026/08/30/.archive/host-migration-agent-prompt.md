# Briefing a new agent on a workstation that has not migrated yet

## Before you start the session

1. **Pin the folders.** Right-click `<OneDrive>\Sync\cc-config` **and**
   `<OneDrive>\Sync\agent-data` → **"Always keep on this device"**. Wait for both to
   finish. Placeholders block on first read and the launchers read the payload on every
   invocation.

2. **Start the session in the payload dir:**

   ```
   cd "%OneDriveCommercial%\Sync\cc-config"
   claude
   ```

   (macOS/Linux: `cd ~/Library/CloudStorage/OneDrive-*/Sync/cc-config && claude`)

   That directory has no `AGENTS.md`, so the agent starts with clean context. Do not start
   it inside `<OneDrive>\Sync\claude` if that folder still exists on your machine — its
   `AGENTS.md` describes the retired architecture and Claude Code loads it automatically as
   project instructions.

3. Have ready: this host's API keys (in case `~/.claude/claude_env_settings.local.json` is
   missing), and push access to `github.com/DawnEver/{claude-code-config,ai-agents}`.

## The prompt — paste this verbatim

> Read `HANDOFF.md` in the current directory and set THIS machine up on the layout it
> describes. It is self-contained; follow it in order.
>
> Critical constraints:
>
> - If `../claude/` still exists on this machine it is the RETIRED tree; its `AGENTS.md`
>   describes the old architecture and is wrong. `HANDOFF.md` and, after cloning,
>   `docs/sync-architecture.md` are the current truth.
> - Do §2 (salvage) FIRST if `../claude/` or `../agents/` still exist. It is the only step that can lose work.
>   `git status` cannot be trusted in the old tree — the handoff explains the four ways it
>   lies. Use `node rescue-clone.mjs`.
> - Do NOT delete anything under `../claude/` in this session, whatever the verdict. Report
>   what `rescue-clone.mjs` says and stop there. Deletion happens only after every host has
>   been checked.
> - Do NOT run bare `git` commands inside `../claude/` — that is the bug being fixed. The
>   provided scripts are the only sanctioned access.
> - If `rescue-clone.mjs` reports unpushed commits or local branches not on the remote,
>   PUSH them to GitHub before doing anything else, and tell me their names. On the macOS
>   host this found 3 branches with 13 unpushed commits that a checked-out-branch-only
>   check had reported as clean.
>
> When you are done, report: the `rescue-clone.mjs` verdict for both repos, anything you
> pushed, the output of `npm test` in the new clone, and whether `ccc` / `ccds` / `cods`
> start.

## What to expect it to do

§2 salvage (only if the old trees are still there) → clone to `~/Documents/Code/AI/cc-config` AND `~/Documents/Code/AI/ai-agents` →
`setup.js --sync-dir <payload> --replace` → `link-agent-data.sh` → verification checklist.

Nothing is deleted. The old tree stays as the rollback.

## Afterwards

Later sessions on that machine should start in the NEW working tree:

```
cd %USERPROFILE%\Documents\Code\AI\cc-config
claude
```

There the project `AGENTS.md` is current and `.claude/rules/rem/path-conventions.md` is
loaded every session, so the agent inherits the correct invariants automatically.

## If something goes wrong

Everything in Phases 1–2 is reversible: delete `~/.claude/sync-dir` and re-run
`node scripts/setup/setup.js --replace` from `<OneDrive>\Sync\claude`. The payload files
were copied, not moved.

The one irreversible risk is deleting the old tree while it still holds the only copy of
something — which is why this prompt forbids deletion.
