---
name: public-repo-hygiene
---

# Public repos carry no local or personal facts (2026-10-02)

cc-config, cc-market and lab-commons are all PUBLIC. The user caught fleet machine names
in `AGENTS.md`/`README.md` and asked for a systematic sweep of all three.

**Rule:** no tracked file names a machine, username, real home/cloud path, chat id, forge
host or org, private consumer project, or personal email. Docs describe the mechanism with
placeholders (`<machine>`, `<chat-id>`, `<project>`, `~/...`); fixtures use neutral values
(`host-a`, `proj-x`, `user@example.com`). Author attribution (name only, no email) in
`LICENSE`/manifests is deliberate and kept. Fleet facts live in the sync payload or
machine-local files, never in git.

**Guards (each fails on reintroduction):**
- cc-config: `node scripts/setup/doctor.js --public-hygiene` (part of `npm run doctor`),
  `.githooks/pre-commit` (setup sets `core.hooksPath`), and a real-tree test in
  `scripts/setup/doctor.test.mjs`.
- cc-market: `scripts/check-public-hygiene.mjs` (pre-commit + release test).
- lab-commons: `tests/test_no_tracked_file_carries_private_markers.py`.
- All three read the machine-local denylist `~/.claude/private-markers` (literal or
  `/regex/` per line). It is never committed: a committed list of private words is itself
  the leak.

**Decisions:**
- Memory was desensitized IN PLACE, not moved out of git.
- Git history was NOT rewritten (user decision); only the current tree is clean.
- lab-commons stored facts about its consumers; desensitizing them broke 4 sibling-census
  tests. Fix chosen: move those facts into each consumer's own tests (lab-commons keeps only
  the kit) — delegated to the integrator session.

**Gotcha:** the auto-mode classifier blocks a bulk rewrite of tracked memory when the
approval is relayed to a subagent. The main loop must act on the user's direct word.
