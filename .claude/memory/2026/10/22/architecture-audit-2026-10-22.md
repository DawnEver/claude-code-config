---
name: architecture-audit-2026-10-22
description: Whole-repo audit (bridge, dashboard, setup/runtime/hooks) against first principles, SSOT, layering, naming — ranked gaps, none fixed yet
metadata:
  type: project
---

# Architecture audit 2026-10-22 (pending user go-ahead; none fixed yet)

Three read-only reviewers (bridge / dashboard / setup-runtime-hooks). Security: no gap found.
Proposed: fix all P0/P1/P2 small items in one pass (separate tested commits); the two M items later.

## P0 — real bugs / misleading behaviour
1. @ cleanup does not survive a bridge restart: `s.mention` + `s.unread` memory-only
   (daemon.mjs `#posted/#clearMention`); persist in topics.json (`cacheEntry`), never count the mention as unread. (S)
2. Config tab unreachable when no accounts and no events: `tabs().show` hides the whole tab bar. Always show it. (S)
3. No Cache-Control in `public/_headers`; Reload button + hand-kept `PAGE_FILES` stand in. Add `Cache-Control: no-cache`, drop Reload. (S)
4. `.claude/rules/rem/migration.md` names `KNOWN_ALIAS_NAMES`/`migrateOrphanedAliases`; code has `KNOWN_WRAPPER_NAMES`/`migrateOrphanedWrappers`. (S)

## P1 — single source of truth
- Status vocabulary x3: schema `STATUSES`, daemon `STATUS_CODES/STATUS_LABELS`, view `STATUS_LABELS/RANK`. One table in dashboard-schema.
- CLI wrapper names in `setup.js` KNOWN_WRAPPER_NAMES and `install-cli-wrappers.js` ALIASES (drift -> migrate deletes a new wrapper).
- Editable config keys hand-listed again in `context.mjs` configSummary vs `CONFIG_KEYS`.
- 15-min quota stale threshold in `quota.mjs` STALE_MS and `view.mjs` QUOTA_STALE_MS.
- Config tab still has its own host order (`configView`) and header (`renderConfig`) — not hostsView/hostSection.
- Hardening: `/api/config` reads full body before 4 KiB check (api.mjs); use the push's content-length pre-check.

## P1 — layering
- Worker imports page code (`registry.mjs` <- `public/view.mjs` quotaAlertsFor); demo.mjs regex-parses event text back. Structured events. (M)
- Codex attachments via the Claude adapter IPC; daemon special-cases `agent === 'claude'` twice. Host-neutral endpoint. (M)
- `setup-vscode.js` and `context.mjs` resolve the sync dir themselves (rule: only setup/check-links).

## P2 — historical baggage
- Pre-Aug `env:<provider>` key migration (`migrate-local-env-settings.mjs` + test + docs/providers.md section) runs every setup.
- `claudeProcessWrapper` cleanup duplicated in setup-vscode.js; `ensureRealDir` ~/.codex/skills junction conversion.
- OneDrive throttle comments (codex.js, check-links.js, setup.js, setup-check-hook.js); refs to retired migrate-host.mjs, takeover.
- AGENTS.md: cc-market listed twice, retired scripts/migration paragraph, false "both launchers check links", missing context.mjs/jsonrpc.mjs/send-attachment.mjs.
- Dead: `isChangeId`, Registry.accept `alerts`, `DashboardPush.machine`, `GET /api/hosts/:id/sessions`, `?? undefined` in #postNow, `#selectTitle` loop written twice.

## P2 — names/docs vs code
- dashboard.md: "DO keeps nothing on disk" (events/alerted are persisted), stale API table, undocumented 1 h run-out alert.
- `dashboardSnapshot()` returns only sessions; "banner" names both `#summary` setting and `#banner` strip; 5 stale comments in app.js; 'Claude'/'Codex' open-coded 6x.
- daemon.mjs header lists wrong adapter events; notify-hook.js macOS finds terminal-notifier only in Homebrew dirs.
- accountIndex/quotaView computed 2-3x per render.
