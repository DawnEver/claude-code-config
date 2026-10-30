---
name: dashboard-cost-billing-background
description: Usage cost dating fix, unknown sessions hidden, API balance framework, idle background-task count, and why dashboard deploys fail since 2026-10-22
---

# Dashboard: cost dating, billing, background tasks (2026-10-30)

Commits 78ec281, bed276f, b32e21e, 2d777b0.

## Cost: week ≈ month was a real bug
`session_costs.updated_at` is the ingest time, so the 10-23/24 backfill stamped every past
session "this week". `report()` (scripts/dashboard/usage-store.mjs) now ranges a session's cost
by its last turn's `MAX(turns.ended_at)`. Live: 7d ≈ $11k vs 30d ≈ $48k.

## Unknown sessions hidden
`dashboardSessions()` (daemon.mjs) drops a session whose host snapshot reports
`state: 'unknown'` explicitly (a missing snapshot still shows `unknown`: test fakes rely on it).
Codex observation-only sessions are hidden by this.

## Billing (API platform balances)
`bridge.billing: [{provider, label?, keyUsername?}]` in shared settings; no key there.
`scripts/bridge/billing.mjs`: one `READERS[provider]` function each; key from the git credential
store (provider cache host + session username); account key = provider + sha256 key
fingerprint so hosts sharing a key merge; 15-min background refresh, 15 s fetch timeout.
Push field `billing` -> schema -> registry `billing()` -> Quota tab "API balance".
Only DeepSeek has a reader (`/user/balance`). Anthropic/OpenAI give no balance to a normal
API key (Admin key gives spend only) — a future reader would derive balance from a recorded
top-up minus spend. Not done: D1 history, forecast, low-balance alerts.

## Idle with background tasks
`backgroundTasks()` (scripts/hooks/bridge-hook.js), counted at every Stop and sent as
`background` on the final; adapter exposes it on an idle snapshot; page shows
"idle · N running in background". Start = tool result *beginning* with
"Command running in background with ID:" or "Async agent launched…agentId:"; end = a
notification beginning `<task-notification><task-id>X…<status>completed|failed|killed|stopped`
or TaskStop's result `{"message":"Successfully stopped task: X` (TaskStop sends no
notification). Anchoring matters: unanchored matching counted task ids quoted in grep
output. Monitors excluded (expire without a closing notice). Starts > 24 h ignored. A
textless Stop now still sends a final (idle, count 0). Codex: no count.

## Deploy failing since 2026-10-22
`dashboard-deploy.yml` fails at "Migrate the usage store": Cloudflare 7403 — the
`CLOUDFLARE_API_TOKEN` lacks Account → D1 → Edit. Live site has no code after 10-22 18:03.
Local `npm run dashboard -- deploy` needs `wrangler login`. Check what is live with
`curl https://<dashboard domain>/app.js | grep <new symbol>`.

## Lessons
- Do not ask the user to log into `gh` when the live site already answers the question;
  push uses git's own credentials. If git push auth fails after a gh login, push once with
  `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push`.
- Python heredoc `"\n"` inside JS source becomes a real newline (and `\\n` vs `\n` confusion):
  edit source with the Edit tool (see editing-source-via-shell).
- sharp-review: `anthropic` provider has no key on this host; plan with `--providers codex`.

## Idle compaction (settings)
- "Compacts by itself after a while" = `idleCompaction` (default true; compacts a long idle
  session before the prompt cache expires). Off via `"idleCompaction": false` in shared
  claude_settings.json. Keep `autoCompactWindow` — the user wants it; do not use DISABLE_AUTO_COMPACT.
- Deploy still red at D1 migrate (7403) until the CF token gets Account → D1 → Edit.

## Provider attribution (ccds / cods)
- ccds: cc-launcher sets `HARNESS_PROVIDER`; session-bridge server reports `provider`. cods: the
  app-server Thread's `modelProvider` (`openai` = subscription). `accountFor(s, accounts, billing)`
  maps a provider session to that provider's billing key, never the seat/login beside it.
- A session started before this code has no provider; it needs a relaunch (old channel server).
- One DeepSeek account read by two hosts with different keys = two fingerprints. Registry merges
  entries with equal provider+label+balances (`keys[]`); `billingSessions` matches any key, or
  provider when the host holds no key (account null).
- Quota tab: a balance sits under each host whose sessions spend it; unused ones at the bottom.
- Avatars: platform marks from Simple Icons in `public/logos.mjs` (path data only, built via DOM).
- Deploy: CF token "Edit Cloudflare Workers" got Account → D1 → Edit on 10-30; CI deploys again.
