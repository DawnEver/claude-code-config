---
name: synced-skills-off-switch
description: Claude Code's account-level synced skills (anthropic-skills:*) download into ~/.claude/skills/synced, which is a symlink into this repo's skills/, polluting the working tree and injecting 8 unwanted skill descriptions per session. The off-switch is the syncClaudeAiSkills setting, found by grepping the claude.exe bundle.
metadata:
  node_type: memory
  type: project
---

# Account-synced skills: why they land in the repo, and how to turn them off

## Symptom

`git status` showed an untracked `skills/synced/` (4.1 MB) holding a UUID-named bucket
plus a `.bucket-<uuid>` marker, containing `docs`, `docx`, `pdf`, `pptx`, `xlsx`,
`skill-creator`, `morning`, `import-memory`. The same eight also appeared in every
session's skill list as `anthropic-skills:*`, costing context.

## Cause

These are **account-level synced skills** — `manifest.json` marks each with
`source: anthropic` or `anthropic-example`. The CLI downloads them from the claude.ai
account skill library into `~/.claude/skills/synced/`. Because `setup.js`'s `CLAUDE_LINKS`
makes `~/.claude/skills` a symlink to `repo/skills/`, they land straight in the working tree.

Nothing in this repo produced them, and deleting the directory is not a fix: it was
re-downloaded within the same session.

`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` (already set in `claude_settings.json`) does **not**
cover this — it gates *bundled* skills; synced skills are a separate `loadedFrom: "syncedSkills"`
channel.

## The off-switch

Grepping the CLI binary turned up the gating descriptor:

```
settingKey: "syncClaudeAiSkills", policyKey: "allow_account_skills_sync",
flagName: "tengu_account_skills_sync_enabled"
```

So the fix is one setting, applied in two places:

- `claude_settings.json` (the **sync payload**, so all three hosts get it) — `"syncClaudeAiSkills": false`
- `claude_settings.template.json` — same key next to `enableArtifact`, so new clones default to off
- `.gitignore` — `skills/synced/` as a backstop, in case the channel ever reopens

Already-injected skills cannot be unloaded mid-session; the change takes effect on next start.

## Technique worth reusing: grep the CLI bundle

`claude` here is a ~225 MB single-file binary at
`~/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe`. `strings` found nothing
useful (the JS is not NUL-delimited), but `grep -a -o -E` on the raw file works well:

```bash
grep -a -o -E "CLAUDE_CODE_[A-Z_]*SKILL[A-Z_]*" claude.exe | sort -u   # env var names
grep -a -o -E ".{300}CLAUDE_CODE_SYNC_SKILLS[^_].{200}" claude.exe     # surrounding code
```

That is how both the env-var list and the `syncClaudeAiSkills` settingKey were found. Use it
whenever an undocumented CLI behaviour needs a config switch.

## Also this session

- The user asked for a mechanism to stop agents spinning on repeated identical actions.
  Decided: a `PreToolUse` loop-guard hook only (no `GLOBAL-AGENTS.md` / `AGENTS.md` rule),
  warn on the 2nd identical `(tool, normalized input)` call, `permissionDecision: "deny"`
  on the 3rd. **Not yet implemented** — still open.
