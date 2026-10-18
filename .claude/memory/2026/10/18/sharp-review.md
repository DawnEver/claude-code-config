---
name: sharp-review-2026-10-18
description: Sharp review findings — 44 total
metadata:
  type: project
---


## Review 2026-10-18 (session) — architecture survey (架构锐评) + diff review

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): FAILED
- Reviewer deepseek (deepseek): skipped
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20261018-001] [HIGH] scripts/bridge/daemon.mjs — daemon.mjs is 833 lines and the Bridge class is about 690 of them, over the 600-line must-split limit.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split into inbound router, outbound mirror, fleet scheduling glue and attachment handling; keep only main() and wiring in daemon.mjs.

Imports 11 modules; tests must construct the whole Bridge to test any one behaviour.

---

### [SR-20261018-002] [HIGH] scripts/setup/setup.js — setup.js is 774 lines, over the 600-line must-split limit.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Extract link tables to a module shared with check-links.js and migrate.js; split sync-dir seeding and machine/MCP registration into steps.

check-links, doctor and migrate all need the link layout; it should live in one module.

---

### [SR-20261018-003] [MEDIUM] scripts/setup/doctor.js — doctor.js (559 lines) grows by design with every incident and is close to the split line.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** One file per check under scripts/setup/doctor/ exporting {id, incident, run}.

Append-only growth in one file.

---

### [SR-20261018-004] [MEDIUM] scripts/bridge/ — scripts/bridge/ is a catch-all mixing transport, adapters, session domain, fleet reporting, service install and CLI entry points.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Subfolders bridge/transport, bridge/adapters, bridge/session, and a separate scripts/fleet/ for fleet, quota-series, extra-resets, fleet-push.

Fleet reporting is a separate product hosted inside the session bridge.

---

### [SR-20261018-005] [MEDIUM] scripts/bridge/codex-adapter.mjs — Host adapters (468/450 lines) share no written event contract.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Define adapters/contract.mjs and a contract test run against both adapters.

'Emit the same events' is convention only; drift risk.

---

### [SR-20261018-006] [MEDIUM] scripts/bridge/context.mjs — Local secrets/machine.json paths are known and printed in ~8 non-test files instead of via shared/config.mjs and shared/machine.mjs.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Export path constants and error text from the shared helpers.

Moving the local secrets file requires editing all of them.

---

### [SR-20261018-007] [MEDIUM] scripts/runtime/cc-launcher.mjs — cc-launcher.mjs and codex-launcher.mjs duplicate provider-projection logic.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Extract shared provider-projection.mjs; launchers keep only host-specific mapping.

Two copies that can drift, contradicting the stated purpose.

---

### [SR-20261018-008] [MEDIUM] AGENTS.md — AGENTS.md is 147 always-loaded lines, mostly mechanism (loop-guard knobs, hook ordering, retired entries, bridge internals).

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Trim to ~60 lines of rules and pointers; move the module catalogue to docs/architecture.md.

Per-session context tax and duplicate of code facts.

---

### [SR-20261018-009] [LOW] AGENTS.md — cc-market/ is listed twice in Structure with contradicting descriptions.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the second entry.

Already drifting.

---

### [SR-20261018-010] [LOW] .claude/rules/rem/migration.md — Always-loaded rule carries history (takeover->fabric swap, stamp-memory deprecation) duplicated in AGENTS.md.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Keep only the per-plugin migration convention; move history to memory.

Duplicated in AGENTS.md setup section.

---

### [SR-20261018-011] [LOW] docs/bridge.md — docs/bridge.md is 659 lines mixing operator doc, design doc and config reference.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Split into bridge-setup.md, bridge-design.md, fleet.md.

Grows alongside the daemon.

---

### [SR-20261018-012] [INFO] scripts/fleet-gateway/ — fleet-gateway has clean boundaries (only shared/fleet-schema and is-main); registry is in-memory so a restart shows an empty fleet until hosts push again.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document the in-memory registry limit; use this shape for fleet reporting when extracted.

No import cycles found in bridge, gateway or shared.


## Review 2026-10-18 (follow-up)

## Review 2026-10-18 (session) — diff review + docs review (文档锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): OK

### Confirmed findings

---

### [SR-20261018-013] [HIGH] scripts/bridge/fleet-push.mjs — A push the gateway refuses ({accepted:false}, HTTP 200) is reported as success, never logged, and clears lastError.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Read the response body; treat accepted:false as a failure with its own log line.

---

### [SR-20261018-014] [MEDIUM] scripts/fleet-gateway/registry.mjs — Ordering trusts host clock bootAt unbounded; one skewed boot wedges that host's entry until gateway restart.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Clamp bootAt to receivedAt +/- minutes and log refused pushes.

---

### [SR-20261018-015] [MEDIUM] scripts/bridge/context.mjs — fleetGatewayConfig preserves a URL subpath that server.mjs cannot serve; /fleet/ deployments 404 and the test blesses it.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Support a base path in server.mjs or reject non-root pathname.

---

### [SR-20261018-016] [MEDIUM] scripts/bridge/context.mjs — Present-but-invalid bridge.fleetGateway silently disables the push; nothing logs why.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Return a reason and log it at daemon startup; add a doctor check.

---

### [SR-20261018-017] [MEDIUM] scripts/bridge/daemon.mjs — everySeconds has no upper bound; overflowing setInterval becomes a 1 ms loop hammering the gateway.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Clamp everySeconds to e.g. [5, 3600].

---

### [SR-20261018-018] [MEDIUM] docs/fleet-gateway.md — ttlSeconds (gateway) vs everySeconds (host) invariant is unchecked; misconfig shows healthy hosts Offline.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document ttl >= 3x interval and warn on the gateway.

---

### [SR-20261018-019] [MEDIUM] scripts/fleet-gateway/auth.mjs — Viewer initData is a 24 h replayable bearer credential sent on every poll.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Default initDataMaxAgeSeconds to ~3600; warn about proxy header logging.

---

### [SR-20261018-020] [MEDIUM] scripts/bridge/daemon.mjs — Status vocabulary defined three times (STATUS_CODES, STATUSES, STATUS_LABELS) with no cross-check.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Derive from fleet-schema.mjs and add an equality test.

---

### [SR-20261018-021] [MEDIUM] scripts/fleet-gateway/server.mjs — readGatewayConfig silently drops malformed hosts entries, producing unexplained 401s.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Throw or warn on invalid entries.

---

### [SR-20261018-022] [LOW] scripts/fleet-gateway/server.mjs — Rate limiter clears whole map at 10k entries (attacker-resettable) and never expires entries.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Prune expired windows instead of clear().

---

### [SR-20261018-023] [LOW] scripts/fleet-gateway/server.mjs — Default trustProxy:false behind the documented proxy puts all viewers in one rate bucket.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Warn at startup or key limiter by user.

---

### [SR-20261018-024] [LOW] scripts/fleet-gateway/public/app.js — load() polls without in-flight guard and render() is outside try; malformed payload becomes repeated unhandled rejection.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add inFlight guard, move render into try, validate shape.

---

### [SR-20261018-025] [LOW] scripts/fleet-gateway/public/app.js — Every poll rebuilds all selects, closing open native pickers on mobile.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rebuild filters only when options change.

---

### [SR-20261018-026] [LOW] scripts/fleet-gateway/server.mjs — Malformed percent-encoding in path throws in decodeURIComponent and returns 500.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Catch and return 400.

---

### [SR-20261018-027] [LOW] scripts/fleet-gateway/server.mjs — Failed viewer/host authentication is never logged.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Log rejection kind without the credential.

---

### [SR-20261018-028] [LOW] scripts/bridge/fleet-push.mjs — FleetPush silently ignores everySeconds passed via spread.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Destructure explicitly at the call site.

---

### [SR-20261018-029] [LOW] scripts/bridge/daemon.mjs — Adapter statusSnapshot returning null makes fleetSnapshot throw and kills every push.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use optional chaining on the result.

---

### [SR-20261018-030] [LOW] scripts/shared/machine.mjs — Machine names have no length cap while gateway HOST_ID caps at 64.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Share the HOST_ID bound.

---

### [SR-20261018-031] [LOW] scripts/fleet-gateway/public/view.mjs — ago() renders 'NaNd ago' for unparsable dates.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Return a fallback on NaN.

---

### [SR-20261018-032] [INFO] scripts/bridge/daemon.mjs — fleetSnapshot() duplicates fleetSessions()'s projection.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Extract one shared projection.

---

### [SR-20261018-033] [INFO] docs/fleet-gateway.md — Privacy claim is wrong: topic deep link contains the group id (minus -100); the test is tautological.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State it plainly or gate links.

---

### [SR-20261018-034] [INFO] scripts/setup/doctor.js — No doctor check for fleetGateway configured-but-rejected silent divergence.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a doctor check.

---

### [SR-20261018-035] [INFO] scripts/fleet-gateway/server.mjs — New internet-facing service with no installer/supervision and a second bot; tradeoff not argued.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Wire into install-service.mjs or document as manual.

---

### [SR-20261018-036] [INFO] scripts/fleet-gateway/gateway.test.mjs — Tests skip key failure paths: accepted:false, subpath, skewed bootAt, bad %-encoding, trustProxy.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add those cases.

---

### [SR-20261018-037] [HIGH] docs/fleet-gateway.md — Feature docs and code are untracked while tracked files (README, AGENTS, bridge.md, daemon.mjs import, package.json) already depend on them.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Commit all fleet-gateway files together with the tracked edits.

---

### [SR-20261018-038] [MEDIUM] AGENTS.md — scripts/bridge/ file list omits context.mjs, send-attachment.mjs and jsonrpc.mjs.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add them to the Structure list.

---

### [SR-20261018-039] [MEDIUM] docs/fleet-gateway.md — Contradicts itself about `ended`: listed as status but also said to never appear.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Clarify or drop ended.

---

### [SR-20261018-040] [LOW] docs/fleet-gateway.md — everySeconds floor undocumented: values below 5 silently become 15.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document the default and floor.

---

### [SR-20261018-041] [LOW] docs/fleet-gateway.md — Rate limit also covers /api/health and host pushes; API table does not say so.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State ratePerMinute applies to all routes.

---

### [SR-20261018-042] [LOW] AGENTS.md — view.mjs path ambiguous; it lives at public/view.mjs.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Write public/view.mjs explicitly.

---

### [SR-20261018-043] [LOW] docs/fleet-gateway.md — Test glob does not descend into public/; future view tests there would be skipped.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document or extend the glob.

---

### [SR-20261018-044] [INFO] docs/fleet-gateway.md — No npm run alias documented for host-token / set-menu subcommands.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Optionally mention npm run fleet-gateway -- host-token.
