# Codex harness support matrix

Audited against the repository implementation on 2026-10-23. This is a support inventory,
not a claim that every integration has been exercised against a live provider on every OS.
Telegram transport and session discovery are described separately in [bridge.md](bridge.md).

**Conclusion:** shared business logic now has explicit native Codex machine-hook wiring,
thread-scoped loop protection, ordered startup checks, native identity normalization and
completion notifications. REM/review source code supports Codex lifecycle and continuation
semantics. This is not a blanket live-parity claim: installation, native hook trust,
marketplace release/cache activation and provider authentication remain separate steps.

## Reading the statuses

- **Available:** an explicit Codex or host-independent implementation exists, with tests
  where named below. Authentication, installation and configuration remain prerequisites.
- **Implemented:** the new source path and local tests exist; deployment/cache activation,
  hook trust and live acceptance are not implied.
- **Partial:** a working subset exists, but the boundary in the table matters.
- **Not wired:** this repository does not arrange the behavior for Codex. A similar native
  product feature does not count as this harness integration.
- **External:** owned by the host or another repository; not guaranteed by cc-config.

### Source, installation, trust and execution are different states

The tables describe the current source implementation. Setup merges owned machine handlers
into the active home's `hooks.json`, preserves user handlers and never edits Codex trust.
Doctor distinguishes missing/drifted definitions from installed definitions without a
matching execution receipt; a receipt is diagnostic evidence, not permission to trust a hook.
Review definitions with native `/hooks`; neither setup nor tests bypass that review.

After explicit user approval, cc-market was locally released as **v3.1.0**, followed by
the correctness patch **v3.1.1** and runtime-guidance patch **v3.1.2**, without a push.
Native Codex installation/readback on this host confirms REM/sharp-review **2.1.2**
and Fabric/evolve/cc-latex **1.1.2**.
Installed source was checked against the released tree.
The local-source override applied only to the install invocation; the configured Git
marketplace source remains unchanged. Other machines are not updated by an unpushed tag.

Existing sessions can still hold earlier cached code. Old code files were backed up and
restored after native CLI cleanup, without overwriting surviving bytes. New supported
host sessions and normal `/hooks` trust review remain required; provider-dependent live
acceptance is separate. A subsequent native Claude update installed REM/sharp-review
2.1.2 and Fabric/evolve 1.1.2 as enabled user plugins. Old Claude cache files were
byte-verified unchanged; existing sessions still need restarting to load the new bundles.

## Configuration, startup and identity

| Capability | Codex status | Actual behavior and boundary | Implementation |
| --- | --- | --- | --- |
| Global instructions | Available | Setup links `GLOBAL-AGENTS.md` to `~/.codex/AGENTS.md`. The same human guidelines reach both hosts. | `scripts/setup/setup.js`, `CODEX_LINKS` |
| Platform system prompt | Available | The composed head names the linked `system-prompt/codex-base.md`; this is a separate platform prompt, not Claude's prompt. | `codex_config.template.toml`, `system-prompt/codex-base.md` |
| Shared configuration and machine state | Available | Setup composes a real `~/.codex/config.toml`: shared head, generated providers, machine-only trust/hook state and provenance. It is not a payload symlink. | `scripts/setup/codex-config-compose.mjs`, `codex-config-file.mjs` |
| Model catalogue and third-party providers | Available | Provider cache plus host projection rules generate provider blocks and `models.json`. `cods` selects provider/model and loads a key from the credential store. Default OpenAI launches retain the native model catalogue. | `scripts/setup/inject-codex-providers.mjs`, `scripts/runtime/codex-launcher.mjs`, [providers.md](providers.md) |
| Secrets isolation | Available | Provider keys are fetched into the child environment; legacy plaintext provider keys are rejected. Machine-local secrets are not a shared-payload feature. | `scripts/shared/credential-key.mjs`, `provider-projection.mjs` |
| Cross-platform launcher installation | Available | `codc`/`cods` wrappers are installed beside the detected Codex binary. They do not require a shell profile. Windows argument projection uses the spawn shim. | `scripts/setup/install-cli-wrappers.js`, `scripts/runtime/win-spawn.mjs` |
| Native machine-hook registration | Implemented; setup/trust required | One owned dispatcher handles SessionStart, PreToolUse, PermissionRequest and SessionEnd through active-home `hooks.json`. Existing user handlers survive. Plugin hooks remain owned by their plugin bundles; Claude settings are not copied wholesale. | `scripts/setup/codex-hooks.mjs`, `scripts/hooks/codex-hook.mjs` |
| Startup repository pull | Implemented with lifecycle limits | The wrapper still synchronizes before repository imports. Native startup dispatch supplements direct supported launches, uses bounded/idempotent sync and dynamically imports healing/doctor afterward. No auto-push; updating source does not reload an already-running daemon's plugin/config state. | `scripts/runtime/codex.js`, `startup-sync.mjs`, `scripts/hooks/codex-hook.mjs` |
| Link/config self-heal | Implemented | Wrapper bootstrap remains; native startup/resume/fork dispatch runs healing before doctor. `checkLinks()` recomposes Codex config. Coverage requires a host version/config layer that loads and trusts these definitions. | `scripts/hooks/codex-hook.mjs`, `scripts/setup/check-links.js` |
| Doctor | Implemented manually and at native startup | Checks both hosts and managed hook definition/execution evidence. Healthy hook runs are silent. Missing or drifted hooks fail; installed without matching observed execution warns. This is not a live provider or plugin test. | `scripts/setup/doctor.js`, `scripts/setup/codex-hooks.mjs` |
| Machine/agent commit provenance | Available | Setup writes `HARNESS_MACHINE`, `HARNESS_AGENT` and tagged `GIT_COMMITTER_NAME` through `shell_environment_policy.set`; commands in a shared daemon do not need launcher env for these values. Git author is unchanged. Requires a configured machine name. | `scripts/shared/machine.mjs`, `codex-config-compose.mjs` |
| Session/thread identity | Implemented; downstream adoption external | `sessionIdentity()` distinguishes native root lineage from execution thread, preferring native runtime identity over launcher fallback. Guard state uses thread identity, not a shared parent hook ID. `LAB_SESSION` remains a lineage projection, never one static session ID in TOML. External commit/forge consumers must adopt this contract independently. | `scripts/shared/session-identity.mjs`, `machine.mjs`, `vendor-session.mjs` |
| Custom `CODEX_HOME` | Implemented for one active home | One resolver is used by launcher, setup, native hook state, models and rollout scanning; the launcher preserves the resolved home. Collector ownership refuses a different home rather than mixing accounts. This is not concurrent multi-seat account discovery. | `scripts/shared/codex-home.mjs`, `scripts/runtime/codex-launcher.mjs`, `scripts/bridge/ensure.mjs`, `scripts/usage/scan.mjs` |

## Hooks, plugins, memory and safety

There are separate machine and plugin hook surfaces. Native machine definitions are
managed by cc-config; cc-market bundles own their lifecycle logic and host adapters. The
generator validates event support; it does not make arbitrary Claude script internals
portable. Both surfaces require normal native trust review and actual runtime activation.

| Capability | Codex status | Actual behavior and boundary | Implementation |
| --- | --- | --- | --- |
| Repository skills | Available | Setup links each `skills/<name>` individually into the Codex skills directory, preserving built-in `.system` skills. | `scripts/setup/setup.js`, `discoverCodexSkillLinks()` |
| cc-market plugins and MCP | Available with installation | Claude manifests are the source of truth; generated Codex manifests declare skills and a Codex-only MCP manifest with relative paths. Being enabled in a template alone is not a live end-to-end test. | `cc-market/scripts/gen-codex.mjs`, plugin `.codex-plugin/` manifests |
| Plugin slash commands and custom agent types | Partial | Skills/MCP port; Claude's `/plugin:command` and dedicated Claude agent names do not. Sharp-review's hook explicitly chooses Codex's built-in worker and instructs it to use the skill. | `cc-market/scripts/gen-codex.mjs`, `cc-market/sharp-review/hooks/sharp-review-hook.js` |
| Project `.claude/rules/` injection | Implemented in REM source | Native lifecycle source, not rollout size, controls injection: startup/clear/compact restore rules; resume/fork inherit context. Requires the updated REM bundle installed/enabled and its hooks trusted. | `cc-market/rem/scripts/inject-rules.js`, `cc-market/rem/hooks/hooks.json` |
| Memory archive, index and TODO CLI | Available | The files and scripts are host-independent. Invoke REM/TODO skills or the `todo` CLI; do not assume Claude slash-command syntax is portable. | `cc-market/rem/scripts/task-engine.js`, `stamp-memory.js`, `scripts/runtime/todo-launcher.mjs` |
| Automatic REM execution at Stop | Implemented in REM source; bounded | Codex native continuation requests the skill inline unless an inherited-context fork exists. Per-session counters and pending requests update under the shared transaction lock. Only explicit matching, unexpired successful-work acknowledgement marks done; another Stop does not. Active work, user waiting, review claims and `stop_hook_active` defer dispatch. Deferred work can wait for the next eligible normal Stop. | `cc-market/rem/hooks/rem-hook.js`, `scripts/rem-session.js`, `skills/rem/SKILL.md` |
| Prompt-time automatic memory recall | Implemented in REM source | Both hosts use scoped heuristic recall with output budgets. Actually injected entries record semantic access. Arbitrary shell file reads are not reconstructed; explicit memory touch remains available. | `cc-market/rem/scripts/recall.js`, `scripts/rem-prep.js`, `shared/hook-facts.mjs` |
| Memo save/get and compact restoration | Implemented | Blob-hash freshness remains host-independent. Codex structured SessionStart output, including `source=compact`, restores memo listings; PostCompact deliberately returns empty JSON rather than an unsupported context shape. | `cc-market/rem/scripts/memo.js`, `tests/memo.test.mjs` |
| Sharp review | Implemented in source; provider acceptance conditional | Deterministic diff/source gate removes the hidden Claude CLI classifier dependency. Shared host facts handle Codex edits/text; a transaction-locked pending claim is not a completed review. Only matching successful post-review completion advances reviewed hashes. Native continuations are bounded and coordinated with REM. Actual reviewers still need Fabric and configured credentials. | `cc-market/sharp-review/hooks/sharp-review-hook.js`, `scripts/gate.mjs`, `scripts/post-review.js` |
| Evolve and Fabric workflows | Available as skills/MCP | They are separate plugin integrations, not a guarantee that every provider is authenticated. Fabric remains single-machine multi-provider work; cross-machine nodes are retired. | `cc-market/evolve/skills/evolve/SKILL.md`, `cc-market/fabric/.codex-plugin/mcp.json`, [harness architecture §10](harness-architecture.md#10-fabric) |
| Loop guard (repeat-tool anti-spin) | Implemented native PreToolUse | Reuses the evaluator with thread-scoped transaction/atomic state, Codex polling exemptions and merged `harness.loopGuard` settings. Unknown Codex execution-thread identity fails open rather than sharing the parent counter. Hosted tools outside native hook coverage are not guarded; this is not a security boundary. | `scripts/hooks/loop-guard-hook.js`, `scripts/hooks/codex-hook.mjs` |
| Stale plugin cache pruning | Conservative report-only | Native startup writes daily `harness-hooks/cache-report.json` candidates, never deletes. Unknown shared-daemon lazy-load ownership forbids even explicit scanner deletion. Doctor inventory warnings are not proof that a cache is unused. | `scripts/hooks/prune-cache-hook.js`, `scripts/hooks/codex-hook.mjs` |
| Session-end dirty/unpushed reminder | Implemented with bounded scope | Native SessionEnd performs local git-only checks under one short budget, records `last-reminder.json`, writes stderr and attempts an OS notice. It reports cc-config, not every working project. Native session end is not window exit; actual notification visibility still needs surface-specific acceptance. | `scripts/hooks/codex-hook.mjs`, `scripts/hooks/sync-hook.js` |
| Native OS notifications | Implemented native adapters | Composed `notify` handles turn completion; PermissionRequest handles approval; observed input-request tools trigger input-needed notices. Shared preferences and OS senders are reused; Windows text is encoded as data. An explicit user `notify` wins. Hook-path and surface coverage are not universal live acceptance. | `scripts/hooks/codex-hook.mjs`, `scripts/hooks/notify-hook.js`, `scripts/setup/codex-config-file.mjs` |
| HUD, keybindings and output styles | Not portable as Claude assets | Codex has its own configured TUI status line. `claude-hud`, `keybindings.json` and `output-styles/` are Claude integrations, not interchangeable Codex components. | `codex_config.template.toml`, `scripts/setup/setup.js` |
| Permission policy | Separate | Codex sandbox/approval settings come from its TOML head. Claude `permissions.allow/deny` entries are not converted into Codex rules. Public-hygiene remains a git pre-commit gate regardless of host. | Both configuration templates, `.githooks/pre-commit` |
| VS Code provider setup | Claude only | `setup-vscode.js` configures `claudeCode.environmentVariables` and terminal env. It is not a Codex extension provider/provenance adapter. | `scripts/setup/setup-vscode.js` |

## Fleet visibility, usage and collaboration

| Capability | Codex status | Actual behavior and boundary | Implementation |
| --- | --- | --- | --- |
| Dashboard collection without Telegram | Implemented; deployment required | A valid dashboard transport can start the collector without a Telegram bot token. Session/account/resource/usage collectors are reused, Telegram writes are disabled, and no second session registry is introduced. Dashboard authentication/deployment remains required. | `scripts/bridge/daemon.mjs`, `ensure.mjs`, `dashboard-push.mjs` |
| Dashboard live sessions | Partial | Registrations include recent independent rollout observations (unknown status, not proof of an open TUI). Coverage inherits native discovery/presence limits and is not a process inventory; dashboard-only operation does not create remote-control capability. | `scripts/bridge/daemon.mjs`, `codex-local.mjs` |
| Quota/account trend | Available for one collector-owned home | The shared app-server account/rate-limit feed is scoped to the active collector home. Derived series/cursors are home/account scoped; another home is refused rather than silently merged. Concurrent multi-home/seat aggregation is not implemented. | `scripts/bridge/codex-adapter.mjs`, `quota.mjs`, `quota-series.mjs`, `scripts/shared/codex-home.mjs` |
| Machine CPU/memory/GPU | Available, host-wide | These are machine samples, not reliable attribution of resource consumption to an individual Codex thread. | `scripts/bridge/resources.mjs` |
| Historical tokens, turns, tools and branches | Available for persisted rollouts | Scanner reads active/archived rollouts in the resolved active home, independently of live registration. An unbridged session can still have usage. Ephemeral/no-rollout sessions and unregistered simultaneous homes remain outside the source list. | `scripts/usage/transcripts.mjs`, `scan.mjs`, [usage.md](usage.md) |
| Monetary cost | Partial | Codex tokens are parsed; Codex does not provide Claude's `cost-state` entries, so actual Codex session-cost rows are not supplied by this implementation. | `scripts/usage/transcripts.mjs`, [usage.md](usage.md) |
| Usage delivery and SQL | Available with dashboard deployment | Metadata batches require dashboard configuration/host token and deployed D1. Cursor advances after acceptance; SQL endpoint restricts requests to read-only queries. This is not a local-only feature. | `scripts/usage/push.mjs`, `query.mjs`, `scripts/dashboard/usage-store.mjs` |
| Branch/worktree isolation | External policy, host-independent | Git works for both agents. cc-config documents when separate worktrees are needed; it does not automatically allocate or lock them for every concurrent session. Stronger family workflows belong to lab-commons. | [harness architecture §3](harness-architecture.md#3-entities-and-sources-of-truth) |
| Forge provenance | Available; local consumer verified | The installed lab-commons consumer reads `HARNESS_MACHINE`/`HARNESS_AGENT` and the current branch. Three owner-source tests pass, and the installed consumer produces provenance from this runtime environment. No remote issue/PR was written. | [harness architecture §8b](harness-architecture.md#8b-identity-and-provenance), `scripts/shared/machine.mjs` |
| Session commit gates and one-session-one-PR | Not an inspected downstream contract | Current lab-commons source does not require `LAB_SESSION` or native Codex session IDs for Forge provenance. Adding a session gate is a separate owner policy, not repair of a missing Codex environment variable. | `lab_commons.dev.forgework.provenance`, [harness architecture §8b](harness-architecture.md#8b-identity-and-provenance) |
| Official remote control | External; not proven by this audit | The Codex feature flag is enabled in the template. This repo does not provision/pair it or prove that every remote client interoperates with bridge subscriptions. The architecture's prototype inference is not a current live acceptance test. | `codex_config.template.toml`, [harness architecture §11](harness-architecture.md#11-prototype-findings-2026-10-01-codex-cli-01571-claude-code-21286-win11) |

## Verification and remaining acceptance work

### Native identity is not absent

A read-only environment check in this audit's Codex subagent found `CODEX_THREAD_ID`
identifying its current thread and `CODEX_SESSION_ID` identifying the parent session;
`HARNESS_MACHINE` and `HARNESS_AGENT` were present, while `LAB_SESSION` was absent. No
literal session IDs are needed in shared configuration or documentation. The attachment
CLI already consumes `CODEX_THREAD_ID`, proving the repo has a native dynamic-ID integration.
The new native identity helper distinguishes these meanings for cc-config consumers. The
remaining provenance question is adoption by downstream commit/forge consumers, not
whether Codex supplies a dynamic ID or whether one launcher env can reach every daemon.

The adjacent lab-commons checkout's `src/` and `tests/` contained no matches for
`LAB_SESSION`, `CODEX_THREAD_ID` or `CODEX_SESSION_ID` in this audit. Therefore the historical
claim that its current commit gate refuses a missing `LAB_SESSION` was not established;
do not diagnose a present commit failure from that prose. A follow-up inspected owner
revision `4e4467d`: Forge's implemented contract is machine, agent and branch, with no
session gate. All three provenance tests passed using a valid existing interpreter;
the installed consumer also imports and produces provenance in this runtime environment.

### Tests

The original baseline audit ran local tests without plugin installation, paid model
requests, credential changes or remote pairing:

- 89 passing tests: Codex launcher, startup sync, config composition/file projection,
  provider generation, machine identity and vendor resume identity.
- 65 passing tests: link self-heal, doctor, wrapper installation and usage store/parser.
- 150 passing tests: cc-market Codex artifact generation, REM rules/hooks/memos/recall,
  and sharp-review gate behavior.

Unit and fixture tests establish code paths, not live permission or provider availability.
The complete cc-config suite after the bridge repair passed 651 tests, with one skipped
and zero failures; doctor, public-hygiene and whitespace checks passed. Natural bridge
reload and a Telegram acknowledgement verified the additional observation-only session
notice, not independent-session remote control or full provider/plugin live acceptance.
The separate `cc-market/scripts/codex-e2e-live.sh` is **not** a read-only audit: it installs
plugins into the actual Codex home, runs model requests, and bypasses hook trust/approval
for its probes. Run it only as an explicitly approved acceptance action, not automatically
as a doctor replacement.

### Integration implementation acceptance

Native hook installation/merge, ordered dispatch, source lifecycle, thread isolation,
notification mapping, short-budget reminders, custom-home ownership and dashboard-only
collection have local unit/fixture tests. Updated REM source tests cover recall access,
compact restoration, independent session counters, explicit completion, review claims
and bounded continuation. Shared facts and review tests cover current Codex events and
absence of the Claude classifier. Final aggregate counts belong to the task's test report;
the historical counts above are not a live activation certificate for the new changes.

Local release and Codex cache installation are complete. Outstanding acceptance: review
native hook trust; prove execution on each supported
CLI/editor/app surface; and obtain approval for live Fabric/provider review probes.
Native login and local Forge-consumer checks are now verified separately below.
Conservative cache reporting, one active collector home,
bounded Stop scheduling and incomplete arbitrary-shell memory observability are deliberate
boundaries, not missing wiring disguised as parity.

The local release also passed its full JS suite and the cc-academia Ruff/pytest gates
using an existing Python 3.13 interpreter and an off-repository environment. Python 3.15
was not forced past the native dependency's supported ABI. Those release checks made
no remote push or model request; the later approved live probe is recorded below.

Latest full implementation verification: cc-config **732 passed / 1 skipped**, cc-market
**1119 passed / 1 skipped**, zero JS failures. The latest full root rerun includes
Windows batch multiline rejection. Public-hygiene and whitespace checks passed.
Machine-hook entry observations now cover all four managed events after normal runtime
approval paths. These receipts prove invocation, not successful enforcement, visual
notification delivery or acceptance of every source change on every native surface.

## Remaining gaps and acceptance priority

### Local runtime readiness

Read-only follow-up checks on this host established:

- Fabric's actual MCP `list_providers` and `codex_status` tools respond. Catalogue
  enumeration is not proof that every API provider has a working key or model.
- Native Codex reports installed and authenticated; native Claude reports logged in.
  These are login checks, not successful inference or quota-availability checks.
- Fabric's pinned interpreter imports `ai_lab.call`; its protocol version matches
  Fabric's version 2. An installed Fabric backend subprocess correctly rejects a
  malformed request before provider connection, without creating a usage ledger.
- Three lab-commons owner-source provenance tests pass. The installed consumer also
  reads this runtime's machine/agent environment and emits a nonempty provenance stamp.
  This establishes the local contract, not remote Forge authentication/write access.

Those readiness checks made no model request or credential change. A subsequent normally
approved read-only Fabric-to-Codex task in an isolated temporary directory returned the
exact requested `HARNESS_OK` text. It did not resume an existing thread or bypass trust.
This proves that native task path, not every API provider or the full review workflow.
No remote issue/PR creation, remote push or pairing was performed.

### Acceptance priorities

Closeout scope: the user deferred multi-home/account aggregation, editor integration,
and external collaboration expansion. They are not release blockers for this iteration.
Existing startup, guard, identity, memory/review, bridge and plugin deployment remain
in scope. Deployment and live acceptance gaps below must not be relabeled as complete.

| Priority | Gap | Next acceptance or deliberate boundary |
| --- | --- | --- |
| P0 | Durable marketplace source and activation | Local v3.1.3 is released, but the persistent native marketplace still uses the Git source while the updater overrides it only per invocation. Resident native reconciliation and cache deletion were observed; two installation attempts failed. Cache presence and invocation-local readback are not durable activation evidence. Choose one durable source before further installation, then verify a fresh default-context session. No remote push was performed. |
| P0 | Fabric Windows executable paths | Controlled fixtures reproduced space-path failures and shell interpretation of `&`. The correction passed the v3.1.3 release gate, but deployment is incomplete: do not assume the active Fabric runtime contains it. Root batch launchers now reject multiline arguments rather than silently truncate them; use a native executable or stdin for multiline input. |
| P1 | Approval notification acceptance | Entry observations now include PermissionRequest as well as startup, tool-use and shutdown. User-visible delivery and each supported surface still need acceptance; receipts do not establish successful lifecycle completion or every source revision. |
| P0 | Mixed-host runtime acceptance | Earlier v3.1.2 cache comparisons matched across both hosts, but that does not establish current activation after native reconciliation. Claude remains on the previous release; Codex v3.1.3 installation is incomplete and its effective runtime version is unverified. Fresh-session lifecycle/gate acceptance remains required. |
| P1 | Live lifecycle/provider acceptance | Exercise recall, automatic compact restoration, REM/review coordination, approval/input notices and real OS delivery. Paid Fabric/provider probes require separate approval/authentication. |
| Deferred | External worktree policy | Out of this iteration's scope by user decision. Current Forge machine/agent/branch provenance is locally verified. Automatic lane allocation/locking remains the owner's policy; no absent session gate is inferred from historical prose. |
| P1 | Native cache-cleanup atomicity | Native startup can delete old versions too. Preservation-only lifecycle recovery reduces persistent loss but cannot eliminate the vendor's deletion window; use a closed-client maintenance window for uninterrupted imports. |
| Deferred | Concurrent homes/accounts | Out of this iteration's scope by user decision. One explicit home per machine collector is supported, not simultaneous multi-seat discovery or aggregated account presence. |
| Deferred | Editor integration and external remote pairing | Out of this iteration's scope by user decision. VS Code provider switching remains Claude-specific, not a Codex extension switcher. Existing local CLI lifecycle acceptance is still required. |
| Boundary | Limited automatic observability | Arbitrary shell memory reads, exact window presence, actual subscription monetary cost, and no-rollout ephemeral sessions cannot be inferred completely from current inputs. |
| Boundary | Bounded rather than immediate automation | REM/review can defer to the next ordinary Stop; shutdown reminders concern cc-config, not every project. Independent Telegram observation has no fabricated live-control endpoint, and reconnect/handoff is not a durable exactly-once outbox. |

### Follow-up correctness audit

Qualified native polling tools now share the same exemption policy as their bare
names. Only known native namespaces are normalized; arbitrary provider suffixes
remain guarded, and history retains the original full tool name. Native hook
inspection also compares managed group constraints, so a changed matcher cannot
reuse a previous receipt to falsely report a healthy installation.

The plugin follow-up found that parent `session_id` was still used for REM/review
state despite the machine guard's execution-thread contract. Plugin gates now
normalize native thread/agent IDs and rollout UUIDs before environment fallback;
unknown Codex execution identity cannot claim a parent slot. The regression suite
uses actual hook subprocesses sharing one temporary project, not just pure helpers.
Counters and acknowledgements remain per execution thread, while unexpired REM/review
reservations exclude other lifecycle continuations across the whole checkout. Deferred
work is reconsidered at an ordinary Stop after completion or expiry. An expired review
lease cannot credit successful reviewed hashes, even if its old token still matches.
Failed claim writes cannot dispatch a continuation; failed acknowledgement writes
cannot report completion. Review output to stdout without persisted findings also
cannot advance reviewed hashes.

The cache updater now checks source payload presence and native registration before
skipping an occupied immutable version and after native installation. A partial or
orphaned target fails explicitly rather than being called updated. Registered disabled
targets stay disabled, and an older disabled installation blocks the whole update before
any add; native add's enablement is not silently treated as an update. Native list cannot
distinguish explicit disable from default state before a plugin is installed.
Deployed Claude/Codex bundles were compared with all **556** tracked
source files across their installed plugins, with no differences.
Each host's installed REM/review cache also passed **122 offline tests**, including
actual subprocess continuation coordination, recall, memo/compact restoration and
failed-write handling. Those executions used temporary fixture projects and do not
stand in for native trust review or a live provider acceptance test.

Claude's native updater initially refreshed its GitHub marketplace and reported
REM 2.0.0 as current despite the unpublished local release. A subsequent update
used invocation-only Git URL rewriting to fetch the local release through the
same native updater. REM/sharp-review 2.1.2 and Fabric/evolve 1.1.2 were read back
as enabled. Old cache versions and the install registry were backed up first;
all protected old files remained byte-identical. No persisted marketplace source
replacement, remote push or trust bypass was used. A manual checkout in the cache
is not sufficient because native refresh replaces it.

Runtime REM guidance was also reconciled with the implemented retention policy:
the full catalog has no count capacity, the injected hot index is bounded, and
feedback entries are exempt from stale short-term eviction. Active skill references
no longer instruct agents to enforce the retired 20-entry cap or advisory threshold.

A first read-only shell approval probe did not immediately produce a PermissionRequest
receipt; subsequent normal runtime activity did. Neither observation proves native UI
coverage or user-visible notification delivery.

The approved native task also exposed two real startup incidents. Native Codex ignored
the retired root `windows_wsl_setup_acknowledged` key; the template no longer includes
it, local composition filters it without editing the shared head, and doctor detects
recurrence. A subsequent app-server initialization reported no retired-setting warning.

Native cleanup removed 41 snapshot-protected old-cache paths. A concurrent deletion then
interrupted replacement-snapshot preparation with `ESRCH`. The updater now retains the
previous validated recovery source even on preparation failure. Preservation-only native
hook recovery repairs missing files before startup diagnostics and checks shallow losses
before tools. Restored files are staged then published exclusively, never partially
written into a live cache or substituted for a concurrent survivor. This is per-file
publication safety, not atomic version installation or control over vendor deletion.

A legacy empty lock prevented recovery until read-only Windows Restart Manager checks,
calibrated against a known live Node handle, established that no process held it. It was
then reversibly quarantined, not deleted or stolen from a live process. New lock records
include PID/token/time; doctor warns about unknown or inactive owners and never reclaims
them automatically. Full inspection subsequently found no missing protected files.
Healthy quick recovery checks measured 319–360 ms on this host. Their one-second budget
limits scheduled validation/copy work; an individual OS I/O call cannot be preempted.
