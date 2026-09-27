---
name: sharp-review-2026-09-27
description: Sharp review findings — 5 total
metadata:
  type: project
---

## Review 2026-09-27 (session) — dependency review (依赖锐评) + architecture survey (架构锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped

### Confirmed findings

---

### [SR-20260927-001] [MEDIUM] cc-market/.github/workflows/plugins-ci.yml:34 — Watch CI installs mutable, unbounded dependencies without a lockfile or hashes

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Create a committed lock or constraints file for the Watch test environment and install it with hash verification.

The workflow installs lower-bounded requirements, so each run may resolve a different graph, including future breaking or compromised transitive releases. This makes CI non-reproducible.

---

### [SR-20260927-002] [LOW] cc-market/.github/workflows/plugins-ci.yml:12 — New CI workflow references actions through mutable major-version tags

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Pin checkout and setup-node to reviewed full commit SHAs and update them through automation.

Mutable action tags can move without a repository commit and execute before repository tests with workflow context.

---

### [SR-20260927-003] [HIGH] scripts/hooks/prune-cache-hook.js:60 — Live-version background scan references the removed CACHE_ROOT symbol

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Pass or serialize CACHE_ROOTS into the generated scanner and add an integration test that exercises spawnLiveVersionScan.

The template interpolation evaluates JSON.stringify(CACHE_ROOT) before entering the generated try block. It throws on every scan, so live cache data never refreshes and cleanup can delete plugin versions still used by running Claude or Codex processes.

---

### [SR-20260927-004] [MEDIUM] cc-market/scripts/gen-codex.mjs:199 — Generator leaves stale Codex MCP artifacts after the source manifest is removed

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** When the source MCP manifest is absent, delete .codex-plugin/mcp.json and cover source-removal reconciliation with a regression test.

The generator writes mcp.json only when the source exists but never reconciles an old generated output after source removal, so release commits may retain a stale MCP manifest.

---

### [SR-20260927-005] [MEDIUM] cc-market/scripts/release.sh:25 — Release baseline permits an unpushed release commit to be released a second time

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Detect that HEAD is already covered by current marketplace version tags or include the latest release commit in the baseline, with a double-run integration test.

Because the baseline is the upstream merge-base, rerunning after a local release but before push sees the same plugin changes and can create another patch bump and tag.
