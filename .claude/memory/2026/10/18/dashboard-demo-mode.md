---
name: dashboard-demo-mode
description: Dashboard `?demo` masks the live snapshot in the browser by rule; public-hygiene and shell-escaping gotchas
---
# Dashboard demo mode (2026-10-18)

## What
- `?demo` = the LIVE snapshot, masked in the browser by `demoMasker()` (`scripts/dashboard/public/view.mjs`),
  wired in `public/app.js`. User chose this (option A) over pure fake data (option B): looks exactly
  like the real view, but real data still reaches the browser, so only allowlisted viewers.
- General rules, not a mapping table: values numbered by first appearance, stable for the page's
  life (closure state survives polls). Machines -> `Workstation N`; seat alias -> `team-a/b…`, its
  org shares the letter -> `Team A/B…`; emails -> `userN@example.com`; projects -> `project-a…`
  (incl. `bridge.projects.<name>` config keys); branches except main/master -> `branch-N`; session
  ids -> `session-N`; Topic chat id -> `100000000N`; account keys -> `<agent>:account-N`.
- Free text (events, seat problems, dashboardError): emails by shape, then every already-masked
  name, longest first, boundary-guarded. A name only ever seen in free text is not masked.
- Config edits disabled in demo (a masked project key would write a wrong key).
- Existing `?mock` (static example data, no API) is unchanged.

## Gotchas
- public-hygiene: test fixtures must not use real host names — `~/.claude/private-markers`
  matches real short host names in prose. Use DESK/LAPTOP, acme-*, corp.example.com.
- Writing JS through a Bash heredoc collapsed `\\` in regexes; fixed with Edit. Prefer Edit/Write
  for regex-heavy source.

## Status
Not committed yet. Open question: add `deploy.mjs set-menu --demo` so the menu button can open `?demo`.

## Update: toggle and templates
- Config tab "This device" -> Demo mode checkbox; localStorage `dashboard.demo`; `?demo` turns it on.
  Pure front end (user requirement). One masker per page; read alerts kept apart under
  `dashboard.readAlerts.demo`; host/project filters reset on toggle.
- Masker moved to `public/demo.mjs`. Free text rebuilt by template (alert `Agent · seat (email): …`,
  seat problem `…, expected email · org`, config `config key = v requested|applied by|refused by`),
  so names seen only in text are masked and short names never touch other words. Unknown text:
  shape + known-name fallback. All review findings SR-20261018-051..056 fixed.
