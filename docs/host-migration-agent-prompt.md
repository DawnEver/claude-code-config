# Briefing a new agent on a workstation that has not migrated yet

## Before you start the session

1. **Pin the folders.** Right-click `<OneDrive>\Sync\claude` **and**
   `<OneDrive>\Sync\claude-config` → **"Always keep on this device"**. Wait for both to
   finish downloading. Placeholders are the one thing no tool can verify remotely, and the
   salvage step depends on reading real files.

2. **Start the session in the payload dir, NOT in the old repo:**

   ```
   cd "%OneDriveCommercial%\Sync\claude-config"
   claude
   ```

   (macOS/Linux: `cd ~/Library/CloudStorage/OneDrive-*/Sync/claude-config && claude`)

   **This matters.** `<OneDrive>\Sync\claude\AGENTS.md` still describes the OLD architecture
   — "centralizes in OneDrive" — and Claude Code loads it automatically as project
   instructions when the cwd is inside that tree. An agent started there will read stale
   guidance that directly contradicts the migration it is supposed to perform. The payload
   dir has no `AGENTS.md`, so the context stays clean.

3. Have ready: this host's API keys (in case
   `~/.claude/claude_env_settings.local.json` turns out to be missing), and the ability to
   push to `github.com/DawnEver/{claude-code-config,cc-market}`.

## The prompt — paste this verbatim

> Read `HANDOFF.md` in the current directory and carry out the migration it describes for
> THIS machine. It is self-contained; follow it in order.
>
> Critical constraints:
>
> - The `AGENTS.md` in `../claude/` describes the OLD architecture and is wrong. Ignore it.
>   `HANDOFF.md` and, after cloning, `docs/sync-architecture.md` in the new repo are the
>   current truth.
> - Do Phase 0 (salvage) FIRST and do not skip it. It is the only step that can lose work.
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

Phase 0 salvage → clone to `~/Projects/claude-config` (or `%USERPROFILE%\Projects\...`) →
`setup.js --sync-dir <payload> --replace` → verification checklist → cc-market salvage pass.

Nothing is deleted. The old tree stays as the rollback.

## Afterwards

Later sessions on that machine should start in the NEW working tree:

```
cd %USERPROFILE%\Projects\claude-config
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
