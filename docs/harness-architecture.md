# Harness Architecture

The design source for a collaborative dev harness spanning many workstations, many
projects, and many tasks per machine, cross-platform, across Claude Code and Codex.
How config reaches each machine is a separate concern — see
[`sync-architecture.md`](sync-architecture.md).

Status: design only (2026-10-01). Decision record:
`.claude/memory/2026/10/01/harness-session-bridge-design.md`.

## 1. Goal and requirements

1. Any number of machines (Windows/macOS/Linux) x projects x concurrent tasks.
2. Both hosts: Claude Code and Codex, treated symmetrically where they allow it.
3. Every control surface — local TUI, phone, official remote — drives the **same live
   session**. No surface spawns a parallel copy.
4. No new state store. Every fact already has an owner; the harness only joins them.
5. First principles, Occam, single source of truth, no backward compatibility.

## 2. Layering: cc-config vs lab-commons

The two repos differ in **whom they serve and how they ship**, which decides ownership:

| | cc-config — general agent development | lab-commons — large-project infrastructure |
| --- | --- | --- |
| Serves | one person: their machines and agents | a family of repos and everyone who contributes |
| Ships with | the machine (setup) | the repo (pip dependency) |
| Applies to | every project, including small personal ones | motronics-studio, wdg-lab, optimi-lab, ... |

The test for any rule: does it still hold in an unrelated repo? Then cc-config. Must
anyone who clones the repo obey it? Then lab-commons. Neither depends on the other; their
only contract is git itself (branches, commits, trailers, refs on origin).

- **cc-config:** branch = one main session's line of work; worktree only when concurrent
  writers would share a checkout (§3); the forge CLI (§8a); agent identity (§8b); bridge,
  Telegram, remotes, launchers, host hooks.
- **lab-commons:** integration layers (`lane -> integrate/main -> main`, `stage/*`),
  gate tiers and verdicts, the three-participant protocol and its readiness rule, repo
  deny rules, famconfig, forge protection declarations — and `fanout.md`'s
  every-subagent-gets-its-own-worktree rule, which is a large-project rule (§3).

## 3. Entities and sources of truth

| Entity | Source of truth | Harness stores |
| --- | --- | --- |
| Project | git repo on Gitea/GitHub | nothing |
| Branch | a branch on origin (`feat/*`, `fix/*`, ...) | nothing |
| Session | the host (Claude transcript; Codex app-server thread) | nothing |
| Machine | cc-config (this repo + sync payload) + `~/.claude/machine.json` | nothing |

**The unit is the branch a main session works on, not the issue.** A branch may relate
to zero, one, or many issues:

- **High-speed feature work** — one main agent on `feat/<slug>` fans out subagents and
  covers many issues; issues are referenced in commits, not in the branch name.
- **Stable-project fixes** — one issue per branch: `fix/<issue#>-<slug>`.

**A worktree is needed only when concurrent writers would share a checkout.** One
session in a repo, read-only subagents, sequential work, or subagents editing disjoint
files under one session can all share a checkout. Two concurrent main sessions in the
same repo on the same machine need separate worktrees. Large projects tighten this
(every subagent isolated, a single editor of the main checkout) through lab-commons
`fanout.md`; that is their rule, not the harness's.

The session is found by its cwd, so the branch is the only join key and the harness
writes no mapping down.

## 4. Control surfaces

All three attach to the same running session:

- **Local TUI** — the session itself.
- **Telegram** — via the per-machine bridge (§6).
- **Official remote** — Claude: `claude --remote-control [name]` (claude.ai / mobile).
  Codex: `codex remote-control start|pair` over its app-server.

| | Inject input | Observe output |
| --- | --- | --- |
| Codex | app-server client (`codex app-server proxy`): `turn/start`, `turn/steer` | app-server events after `thread/resume` |
| Claude | channels (custom channel plugin) | hooks + transcript |

Codex's TUI is itself a client of a shared local app-server daemon, so the bridge is one
more client. Claude has no such daemon; injection goes through channels. Remote Control
is Claude-only: it cannot drive a Codex session.

## 5. Telegram topology

- One **group per project**, Topics enabled; one **Topic per lane session**.
- One **bot per machine**: `getUpdates` allows a single consumer per token.
- Bots do not receive other bots' messages, so Telegram never carries agent<->agent
  traffic.
- Telegram is a **stateless view**. Losing a group or Topic loses nothing; the bridge
  rebuilds the mapping from live sessions.

## 6. Bridge

`scripts/bridge/` in this repo: a per-machine daemon registered by setup, reading config
through `~/.claude/...` links (never a machine path — see `sync-architecture.md` §2).
Not a plugin: a plugin lives and dies with one session, while the bridge must outlive
every session, own the machine's single bot token, and multiplex all its sessions.

## 7. Permissions

- By default approvals stay in the local TUI or the host's official remote. Telegram
  relays text and status.
- Approving from Telegram is opt-in per machine, restricted to an allowlist of Telegram
  user IDs. Anything else is dropped, not queued.

## 8. Agent <-> agent

Already solved by the family protocol and adopted as is: **readiness is the branch tip
moving on origin** (detected by `git cherry` against remote lane refs), and origin is the
only shared medium — "a chat message is a priority hint and may never be the trigger".
The coordinator integrates and re-gates.

Issues fit as **intent, not trigger**: a human files the what and why; lanes reference
it in commits; closing follows the integration landing. Any issue or label convention is
specified in lab-commons (rendered per repo like the other family config), not here.

## 8a. Forge CLI — one interface over Gitea and GitHub

git itself is forge-neutral; only the forge API (issues, PRs, labels, comments, auth)
differs. `scripts/forge/` installs a thin `forge` command:

- Verbs agents need, nothing more: `forge issue list|view|create|comment|close`,
  `forge pr create|view`.
- Backend picked from `git remote get-url origin`: GitHub -> `gh`, Gitea -> `tea`. The
  CLI maps arguments and normalizes output; it has no API client of its own.
- Auth is each tool's own machine-local login; no token rides the sync payload.
- Agents write to the forge only through `forge` (a deny rule blocks direct `gh`/`tea`
  writes), so provenance (§8b) cannot be bypassed.

## 8b. Identity and provenance

Every commit or comment carries three layers. Only the first was recorded before.

1. **Accountable person** — always you. Git author, and the forge account.
2. **Executor** — which agent (Claude/Codex, model).
3. **Origin** — which machine, branch, session.

No bot accounts: they multiply credentials and lose layer 1. Instead:

- **Commits:** agent launchers set `GIT_COMMITTER_NAME="<your name> (<machine>/<agent>)"`
  and leave the author alone, plus trailers `Agent:`, `Machine:`, `Branch:`. Manual
  commits in any project are untouched, because the variables exist only inside
  launcher-started processes. No global git hook, so there is no clash with repo hooks.
  Query: `git log --format='%(trailers:key=Machine)'`.
- **Issues/comments:** `forge` prefixes each body with
  `[<machine> · <agent> · <branch> · session <id>]`.
- **Machine name:** `~/.claude/machine.json` (`{"name": "WS1"}`), written by setup on first
  run, never synced, never derived from hostname.

## 9. Phasing

- **v1 — human <-> session.** Bridge for Codex (app-server) and Claude (custom channel,
  claude.ai subscription), Telegram view, official remotes.
- **v2 — coordination view.** The bridge surfaces lane-tip movement and gate verdicts
  in each Topic. It observes; it never triggers.
- **Later — third-party providers on Claude** (DeepSeek via `ccds`), which lack Remote
  Control and channels.

## 10. Fabric

fabric's cross-machine node feature and its session/team tools are retired; this
document replaces them as the multi-device path. fabric remains a single-machine
multi-provider tool (`call`, `fan_out`, `list_providers`, `resolve_model`,
`codex_status`).

## 11. Prototype findings (2026-10-01, codex-cli 0.157.1, Claude Code 2.1.286, Win11)

Codex — verified:
- The shared daemon listens on an AF_UNIX socket, even on Windows
  (`~/.codex/app-server-control/app-server-control.sock`). The bridge attaches via
  `codex app-server proxy` (stdio <-> socket); the TUI attaches via `codex --remote unix://`.
  A stale `.sock` survives a dead daemon, so probe with `codex app-server daemon version`,
  never by checking whether the file exists.
- Two clients on one thread both receive `turn/*` and `item/*` events, but only after
  `thread/resume`. That requires a persisted (non-ephemeral) thread. Any client can
  inject without subscribing.
- To inject: `turn/start` when idle, `turn/steer {expectedTurnId}` mid-turn,
  `turn/interrupt` to stop. Approvals arrive as server->client requests
  (`item/*/requestApproval`); the first client to answer wins, and `serverRequest/resolved`
  notifies the rest.
- Inferred, not tested: `remote-control` is the same daemon with remote enabled, so local
  clients keep working alongside it.

Claude — doc-stated or inferred:
- `--channels` exists but is hidden. Channels is a research preview, needs Bun and Anthropic
  auth, and a custom channel needs `--dangerously-load-development-channels`. Channels can
  relay permission prompts.
- Remote Control needs a claude.ai subscription and is disabled when `ANTHROPIC_BASE_URL`
  is not Anthropic.
- No mechanism other than channels can inject into a live interactive session.
- Still untested: channels + `--remote-control` in one session (expected to work).
