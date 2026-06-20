---
name: persona-vs-output-style
description: Academic-writing in Claude Code uses an output style (partial wash, in-session) not a full system-prompt-replacement persona launcher — full replace degrades CC into a plain chatbox
metadata:
  type: project
---

# Persona Launcher vs Output Style for Academic Writing

**Decision:** For doing academic writing in Claude Code, use an **output style**
(`output-styles/academic.md`, `keep-coding-instructions: false`), NOT a full
system-prompt-replacement persona launched via `cc <name>`.

## Why the persona launcher was rejected

We prototyped a `cc academic` / `ccds academic` launcher that injected
`--system-prompt-file persona/<name>.md` (full `--system-prompt` replacement, a
"clean model"). It worked, but full replacement throws away Claude Code's entire
harness — tool guidance, agentic loop, file/repo affordances. What's left is
effectively a plain chatbox with file tools bolted on; at that point there is no
reason to be inside Claude Code at all (just use claude.ai / a chatbox).

The user's actual workflow is writing **in the terminal**, often switching
between coding and writing in the same session/project. An output style fits that:
it overlays the writing persona on the live session via `/config` → Output style,
strips the coding instructions (`keep-coding-instructions: false`), and keeps the
harness/tools. It's only a *partial* wash (harness base remains) — but that
residue is the whole point; a full wash defeats using CC.

## What was kept vs reverted

- **Kept:** `output-styles/academic.md` (repo-tracked, symlinked to
  `~/.claude/output-styles` via `setup.js` CLAUDE_LINKS). Activate with `/config`
  → Output style → `Academic` (needs `/clear` or new session).
- **Reverted:** persona launcher code — `cc.js` persona resolution block +
  `homedir` import, the `persona` symlink entry in `setup.js`, the `persona/`
  directory, and persona docs in README/AGENTS.

## Gitignore: output-styles must be whitelisted

The `**/.claude/**` ignore-all template only whitelists specific subdirs, so a
project-level `.claude/output-styles/` is swallowed by default. Added
`!**/.claude/output-styles/` + `/**` to the template — `migrate.js`
(`CLAUDE_GITIGNORE_TEMPLATE` + `MANAGED_GITIGNORE_LINES`), its test snapshot, this
repo's `.gitignore`, and the `Sync/agents` repo's `.gitignore` (which owns the
`ai-post` subtree where `post-style` lives). `ai-post` is NOT its own repo — its
git toplevel is `Sync/agents`, so that root `.gitignore` is the one to edit.

## Context (still-true facts)

- `--system-prompt-file` fully replaces the prompt; `--append-system-prompt-file`
  only appends; output styles sit between (replace SWE parts, keep harness).
- CC's default prompt is terseness/tool/code-heavy; the terseness ("minimize
  output tokens") is what most hurts long-form prose.
- For maximum writing purity with isolated context, claude.ai Projects (no
  harness at all) beats any in-CC approach — that's the fallback for serious
  long-form drafting, not a persona launcher.
