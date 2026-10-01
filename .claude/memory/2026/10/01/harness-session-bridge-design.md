---
name: harness-session-bridge-design
---

# Multi-workstation harness: session bridge design (supersedes multi-device-fabric-direction)

Decision (2026-10-01, design only, nothing implemented yet). Goal: a general collaborative
dev harness — many workstations x many projects (motronics, wdg lab, ...) x many tasks per
machine, cross-platform, Claude Code + Codex. Principles: first principles, Occam, single
source of truth, no backward compat.

Data model — four entities, each with an existing source of truth (we add no state store):
- Project = git repo (Gitea/GitHub). Task = Issue. Session = host-owned (Claude transcript /
  Codex app-server). Machine = cc-config.
- One task = one git worktree + one session; branch `task/<issue#>-...` links issue/branch/PR/session.
- Telegram is a pure view: one group per project (Topics on), one Topic per session, one bot
  PER MACHINE (getUpdates allows a single consumer per token). Bot-to-bot messages are not
  delivered by Telegram, so no agent<->agent over Telegram.

Control surfaces must hit the SAME live CLI/TUI session (not fabric-style new windows):
local TUI + Telegram + official remote. Verified from `--help` (2026-10-01):
- Codex TUI is a client of a shared local app-server daemon (`codex agents`, `--remote <ADDR>`,
  `codex queue --thread --message`, `codex remote-control start|pair`) -> bridge = another
  app-server client. Native multi-client.
- Claude: `claude --remote-control [name]` covers TUI + claude.ai/mobile; Telegram injection via
  channels (official Telegram plugin), observation via hooks. Remote Control cannot drive Codex.
- Open questions: channels + remote-control coexistence; Codex remote-control + 3rd-party
  app-server client coexistence; DeepSeek (ccds/cods) sessions likely lack RC/channels (v1 skip).

Phasing: v1 human<->session only. v2 agent<->agent via issues: trigger only on assign/label,
label state machine (todo->doing->review->done) prevents loops, bridge shells out to `gh`/`tea`.
Bridge lives in cc-config `scripts/bridge/` (per-machine daemon, not a plugin), registered by setup.

Fabric: archive the cross-machine parts (nodes/serve/token, list_nodes, attach_session, LAN
code) — unused. Measure other fabric tools via traceme before archiving them too.
Next steps proposed: traceme usage audit -> archive; write docs/harness-architecture.md; prototype
to resolve the open questions.

## Update (same day): prototype + fabric usage audit

- Prototype results are recorded in `docs/harness-architecture.md` §9 (single source; not
  duplicated here). Headline: Codex is verified to support multiple clients on one thread
  (attach with `app-server proxy`, subscribe with `thread/resume`, inject with `turn/start`/`turn/steer`).
  Claude can only be injected into through channels, which are hidden and need Bun plus
  Anthropic auth. DeepSeek sessions are out of v1.
- Fabric usage on host G only (from transcript tool_use records; traceme has no per-tool data):
  `call` 88, `list_providers` 26, everything else 0 calls (including `fan_out`, and all
  session/team/node tools and skills). The proposed removal tiers A (node), B (session/team),
  C (introspection tools + skills) await the user's choice. Keep `call`, `fan_out`, `list_providers`.
- An auto-mode classifier blocked a subagent prompt that included deleting code. Run the
  audit read-only first, then delete only after the user confirms.
