---
name: dashboard-alerts-tasks-search
description: Events tab removed for bot private-chat alerts, offline detection via DO alarm, failed-turn outbox, live shell/subagent TaskBoard for Claude+Codex, dashboard search, compact load tap; deploy token rules
---
# Dashboard alerts, live tasks, search (2026-11-06, commit e5d3679, deployed)

## Alerts (scripts/dashboard/notify.mjs)
- Events tab + stored history deleted. Every alert goes as the dashboard bot to each
  allowedUserIds private chat: quota (quotaAlertsFor), host-offline, turn-failed, config-refused.
- User ruling: do NOT alert "back online"; recovery clears `down` silently.
- Offline: Registry.sweep(); DashboardHub arms a DO alarm only for the next due host
  (offlineAlertSeconds default 300) -> <=288 DO requests/day; none when all hosts are down.
- Cloudflare budget lesson: `alerted` used to be written to DO storage on EVERY push; now only on change.
- Failed turns: daemon final() -> Bridge.onAlert -> DashboardPush.raise (outbox, id-deduped by
  the gateway). Topic keeps plain `[failed]` line; without dashboard the Topic still mentions.
- Config outcome per key: snapshot.configLast (gateway memory only).

## Deploy
- `deploy.mjs deploy` uploads DASHBOARD_BOT_TOKEN only if this machine has
  bridge.dashboard.botToken; user ruling: any machine must be able to deploy. wrangler
  `--secrets-file` is additive (omitted secrets kept). User accepted the token living in Cloudflare.
- As of the deploy, the token was NOT yet uploaded (deploying machine lacks it): alerts are
  only logged until a machine holding the token runs `npm run dashboard -- deploy` once.

## Live tasks (scripts/bridge/tasks.mjs TaskBoard)
- User focus: how many shells/subagents run now and for how long; no D1 history (saves writes).
- Claude: bridge-hook taskFor (Pre/PostToolUse/PostToolUseFailure on Bash|Agent|Task, by
  tool_use_id); background ends = Stop's backgroundTasks() now returns open tool_use_ids.
  PostToolUseFailure wired in template + live settings. `is_interrupt` field unverified live.
- Codex: trackItem on commandExecution (inProgress -> completed/failed/declined) and
  collabAgentToolCall.agentsStates per subagent thread (shape from `codex app-server
  generate-json-schema`; unverified live).
- Wire: session.tasks replaces `background`; constants in public/shared/vocab.mjs.

## UI
- Search box: searchAll() in view.mjs over hosts, sessions, tasks, accounts, repos, branches,
  PRs, settings; results open Topic/forge/tab. Usage report not searched.
- Compact machine load: tap opens that host to detailed (in-page Set).

## Gotchas
- A real machine name in tests trips public-hygiene private markers; use host-x.
- Bash heredoc + node edits: files are CRLF; edit via a helper that normalizes line endings.
