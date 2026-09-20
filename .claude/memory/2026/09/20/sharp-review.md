---
name: sharp-review-2026-09-20
description: Sharp review findings — 6 total
metadata:
  type: project
---

## Review 2026-09-20 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): OK
- Reviewer gmi (gmi): skipped
- Reviewer kimi (kimi): skipped

### Confirmed findings

---

### [SR-20260920-001] [MEDIUM] claude_settings.template.json — Removing the two default LSP plugin entries silently disables typescript-lsp/pyright-lsp on every fresh install, while fix-lsp-windows.js still patches those plugins

- **Category:** Bug
- **Status:** CLOSED
- **Confidence:** single-reviewer
- **Suggestion:** Keep the LSP removal out of this sync-hook change, or state its rationale in AGENTS.md/README and reconcile it with fix-lsp-windows.js, so a freshly provisioned host does not lose the documented language tooling unintentionally.

setup.js copies claude_settings.template.json verbatim to claude_settings.json and never subsequently modifies enabledPlugins, so dropping these two entries means newly provisioned hosts never enable the TypeScript/Pyright LSPs — yet every SessionStart still runs fix-lsp-windows.js, whose sole job is patching exactly those plugins' binary names. The removal is also unrelated to the sync-hook change and is not recorded anywhere in AGENTS.md or README.md, so the template now silently drifts from the live payload.

---

### [SR-20260920-002] [HIGH] scripts/hooks/sync-hook.js — Main-entry guard compares process.argv[1] against the realpath of import.meta.url; launched through the ~/.claude/scripts symlink/junction (exactly how claude_settings invokes it) the two differ, main() never runs, and the whole feature silently no-ops

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Use a realpath comparison on both sides (fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)), guarding for a missing file) or Node's import.meta.main, and add an integration test that launches the hook through an actual symlink/junction rather than the real checkout path.

Node's ESM resolver realpaths the main module, so import.meta.url (and therefore REPO) resolves to <repo>/scripts/hooks/sync-hook.js, while process.argv[1] retains the path it was launched with — ~/.claude/scripts/hooks/sync-hook.js on macOS (symlink) or the junction path on Windows. When they diverge the equality is false, main() is skipped, the process exits 0 and prints nothing: byte-for-byte indistinguishable from the intended 'already current' silent success. Because the README promises 'every failure is a silent no-op', the user gets no signal that the hook is dead. Every test in sync-hook.test.mjs invokes the real path (node <HERE>/sync-hook.js) and the fixture repos are plain clones with no symlink, so this failure mode is completely uncovered — the suite stays green while the production path does nothing.

---

### [SR-20260920-003] [MEDIUM] claude_settings.template.json — The diff silently deletes typescript-lsp and pyright-lsp from enabledPlugins in the settings template, disabling them on any newly provisioned host while fix-lsp-windows.js still patches those plugins' binaries

- **Category:** Bug
- **Status:** CLOSED
- **Confidence:** single-reviewer
- **Suggestion:** Restore the two entries, or split the removal into its own change with a stated rationale and update scripts/setup/fix-lsp-windows.js and the docs to match. Do not bundle an unrelated plugin-policy change into a sync-hook change.

The template is the provisioning source of truth (setup.js generates claude_settings.json from it). Dropping these keys means fresh installs never enable the TS/Pyright LSPs, yet every SessionStart still runs fix-lsp-windows.js, whose sole job is fixing the LSP binary names for those plugins — now a no-op or a warning on hosts that no longer have them. Nothing in AGENTS.md, README.md or the sync docs explains the removal, and existing hosts' live claude_settings.json no longer lists the plugins either, so the template and the effective config drift.

---

### [SR-20260920-004] [MEDIUM] scripts/hooks/sync-hook.js — A host whose branch has no upstream configured never pulls and never says so, so the sync hook can be permanently non-functional with zero observable signal

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** When a remote exists but the current branch has no upstream, emit a low-noise one-time systemMessage (e.g. 'tracking not configured — run git branch --set-upstream-to=origin/<branch>'). At minimum add a self-check so 'silently not syncing' is distinguishable from 'synced and current'.

upstreamCommit() returns null whenever @{u} is unset — a state the README calls 'normal on a freshly cloned host'. runPull then returns null and formatPull prints nothing, so a host cloned without -u (or whose branch was renamed, or which sits detached) will never fast-forward and never warn, while still appearing healthy. The remind half does not compensate: unpushedCount() falls back to HEAD --not --remotes, legitimately 0 on a clean tree, so SessionEnd is silent too. The only feedback surface for the whole feature is empty precisely when the feature is doing nothing.

---

### [SR-20260920-005] [MEDIUM] scripts/hooks/sync-hook.js — The merge --ff-only catch discards git's stderr and unconditionally blames 'local edits conflict', and the 5s execFileSync timeout can SIGTERM a merge mid-checkout, leaving a partially updated working tree and a stale index.lock

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Capture and surface the real git stderr (include a truncated reason in the note or log it), and do not apply a timeout that can kill an in-progress checkout — or detect the partial state and report it explicitly instead of mislabelling every failure as user edits.

The catch collapses every failure mode into one message: genuine conflicting local edits, an index.lock that appeared after the TOCTOU check, a failing post-merge hook, filesystem permission errors, or a LOCAL_TIMEOUT_MS (5000ms) kill. That is a direct observability loss — when something real breaks the user sees 'local edits conflict', which is wrong and unactionable. Worse, execFileSync enforces the timeout by terminating git; killing merge --ff-only partway through a working-tree update can leave some files advanced and others not, plus an index.lock — a corrupted-in-progress checkout that the hook then reports as a benign conflict.

---

### [SR-20260920-006] [LOW] scripts/hooks/sync-hook.js — The SessionEnd reminder always advises git push even when there is nothing to push, and counts 'unpushed' against stale remote-tracking refs because --remind never fetches

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Tailor the suggested command to the actual backlog (only suggest push when ahead > 0; suggest commit/status when dirty > 0), and either do a bounded fetch before counting or word the count as 'unpushed (last known)' so a stale ref cannot produce false positives.

formatReminder unconditionally appends '— push: git -C "${REPO}" push', so formatReminder({dirty:1, ahead:0}) tells the user to push when they have only uncommitted changes and zero commits to push — the one command it recommends cannot fix the stated problem. Separately, --remind never fetches, so unpushedCount() compares HEAD against last-known remote-tracking refs: if another host pushed the same commits and this host has not fetched, they are reported as 'unpushed' although the remote already has them — a recurring false alarm on exactly the multi-host setup this hook exists for.

---

## Resolution 2026-09-20 (same session)

- **SR-002 FIXED** — root cause was the entry guard
  `path.resolve(argv[1]) === fileURLToPath(import.meta.url)`. Node realpaths the module
  but not `argv[1]`, so under `node ~/.claude/scripts/hooks/...` the guard was false,
  `main()` never ran, and the process exited 0 in silence — indistinguishable from the
  intended "already current" no-op. **The same idiom was already live in
  `loop-guard-hook.js` and `fix-lsp-windows.js`, which means the anti-spin guard had
  been dead in production since it was wired on 2026-09-18**: its state dir held only
  the author's manual smoke-test files and no real session. Extracted
  `scripts/shared/is-main.mjs` (realpath both sides, false on any error) and adopted it
  at all three sites. Regression tests in `scripts/shared/is-main.test.mjs` launch
  through a real symlink/junction, which is the invocation every earlier test missed.
  Reproduced before and verified after, by hand, for all three hooks.
- **SR-004 FIXED** — `formatReminder` now also reports "no upstream set" when a remote
  exists but the branch tracks nothing, so a host that can never fast-forward says so
  instead of looking healthy forever.
- **SR-005 FIXED** — merge timeout raised from 5s to 60s, because a timeout here is not
  a safety net: `execFileSync` enforces it by killing git, and killing a merge partway
  through a working-tree update leaves some files advanced and others not. The failure
  path now calls `formatMergeFailure`, which surfaces git's own `error:` line (the first
  match, not the last — the lines after it are the affected paths) and reports an
  interrupted checkout as the integrity event it is rather than blaming "local edits".
- **SR-006 FIXED** — the suggested command now matches the state (push when ahead,
  review when only dirty, set-upstream when untracked). The stale-ref half is accepted
  rather than fixed: fetching at SessionEnd to make the count exact would put network
  latency on every exit, and `--pull` already fetches at startup, so refs are fresh in
  the normal flow. Revisit if false "unpushed" alarms actually show up.
- **SR-001 / SR-003 CLOSED — not defects, but they found something real.** Both
  reviewers assumed the two LSP entries had been removed by accident and flagged the
  removal as unexplained drift from the docs. The repo owner removed them deliberately.
  The residual they legitimately point at is that `fix-lsp-windows.js` still patches
  binary names for plugins that are now never spawned, so that SessionStart entry is
  dead weight; removing it is pending an explicit decision and is tracked as a todo
  rather than as a review finding.
