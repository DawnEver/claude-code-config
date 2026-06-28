---
name: codex-skills-and-personality
description: Codex setup links repo skills individually and maps Claude output-styles to Codex personality guidance.
metadata.type: project
---

# Codex skills and personality notes

On 2026-06-28, setup was changed so Codex does not replace the whole
`~/.codex/skills` directory with a link to this repo's `skills/`.

Reason: Codex owns built-in skills under `~/.codex/skills/.system`. Replacing the
whole directory would hide or remove those built-ins. Instead, `setup.js`
discovers each repo skill under `./skills/<name>` and links it into
`~/.codex/skills/<name>`, preserving `.system`.

Codex does not use Claude Code's `output-styles/` mechanism. The closest Codex
feature is `/personality` or the `communication_style` config enum for built-in
communication styles. For custom reusable persona/workflow behavior, use
`AGENTS.md` for durable guidance or a Codex skill under `.agents/skills`.
