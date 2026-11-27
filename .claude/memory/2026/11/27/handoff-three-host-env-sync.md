# Handoff: three-host environment sync (Claude Code, Codex, agy) on this Windows host

Session 2026-11-26/27. Goal: every host (Claude Code, Codex, Antigravity `agy`) uses the latest dev
environment equally -- dev-lab harness, claude-code-config, Telegram bridge. <project> is FROZEN
(user, 2026-11-26): the project moves to Gitea `<org>/<project>-v1`; do not sync or edit it.

## Done

- dev-lab: fast-forwarded 573 commits; dropped a local `uv.lock` change (regenerated ai-lab pin, superseded
  upstream). Venv was broken (`lab_commons.objects`/`hostenv` missing): rebuilt via
  `.claude/worktrees/enrol-rotate/.venv/Scripts/python.exe -m dev_lab.dev.dep --root <dev-lab> --sync`; imports OK.
- lab-commons (254) and hosts-config (57): fast-forwarded.
- claude-code-config: `npm run migrate`, `npm run setup` (links `~/.claude`, `~/.codex`, `~/.gemini/config`;
  composed Codex config + hooks; launchers `ccc ccds codc cods agyc todo`; bridge service + session-bridge MCP
  for seats base and evans). agy found at `%LOCALAPPDATA%\agy\bin` (already on user PATH); setup linked
  `GEMINI.md`, merged agy hooks/plugins, wrote statusline and `agyc`.
- Bridge spool: 848 stale mirror calls (oldest ~7 days) DISCARDED at the user's request.
- `npm run doctor`: no FAIL.

## Open

1. lab-commons venv: `dep --bootstrap` fails building `pyyaml` (pulled by `viz-bokeh` -> bokeh). Suspected:
   no pyyaml wheel for the venv's Python (3.15); unverified -- read the full uv output first.
2. hosts-config: no venv (`env_key: missing-environment`); bootstrap failed, cause not yet read.
3. claude-code-config: new venv `.venvs/1e21ce3c3421-20261126T124106Z` built but NOT published -- a live
   Claude session holds `.venv`. Close it, re-run
   `cd claude-code-config && <dev-lab>/.venv/Scripts/python.exe -m dev_lab.dev.dep --bootstrap .`.
4. claude-code-config uncommitted: `migrate` edited `.gitignore` and two memory files
   (`2026/11/19/handoff-agy-integrator-and-p7-gap.md`, `trusted-guard-bridge-and-agy-quota.md`); untracked
   `cc-market/` predates this session. Review, then commit or drop -- not decided.
5. doctor WARNs: `codex-native-hooks` and `agy-native-hooks` not observed -- start one `codc` and one `agyc`
   session to confirm. `plugin-dormant` for rem, sharp-review, evolve, fabric -- unchanged, decide if intended.
6. Pending break-glass waves awaiting review (`python -m dev_lab.dev.forge breakglass status`):
   20261120T151500Z, 20261121T222854Z, 20261123T101100Z, 20261123T212041Z, 20261124T101550Z,
   20261126T120431Z, 20261126T183528Z. Not acked.
7. Not started: WS5 lane `physics-systems` of the v1 migration -- follow
   `.claude/memory/2026/11/27/v1-workstation-setup-handoff.md` in <project>-v1 (integrate/main), steps 1-8
   (worktree `.claude/worktrees/l1-physics-systems`, branch `pr/v1-migration/l1-physics-systems`, hooks
   installed and `protected` confirmed before any commit), then v1 issue #4; <machine> integrates, never merge.
