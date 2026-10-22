# Usage store

Every token, turn, quota window and hour of machine load, kept for months in one SQL database
(Cloudflare D1, beside the dashboard Worker), for the dashboard's Usage tab and for analysis
by a human or an AI. **Metadata only**: ids, times, counts, model, project, branch and tool
names — never a prompt, an answer, a path or a file's content.

```
L0 sources   Claude transcripts  ~/.claude*/projects/**/*.jsonl  (each seat dir too)
             Codex rollouts       ~/.codex/{sessions,archived_sessions}/**/*.jsonl
             quota readings       AccountReader (scripts/bridge/quota.mjs)
             load samples         ResourceReader (scripts/bridge/resources.mjs), every dashboard push
L1 host      scripts/usage/transcripts.mjs  a transcript -> turn rows (pure)
             scripts/usage/scan.mjs         what is new since the cursor (~/.claude/bridge/usage-cursor.json)
             scripts/usage/push.mjs         batches -> POST /api/hosts/<machine>/usage, every 5 min
L2 store     scripts/dashboard/usage-store.mjs + migrations/*.sql   (D1 `agents-usage`, binding USAGE)
L3 readers   Mini App Usage tab (GET /api/usage)   ·   npm run usage (POST /api/hosts/<machine>/query)
```

## Sources of truth

| Fact | Source | Kept as |
| --- | --- | --- |
| tokens, model, calls, tools, times, cwd, branch | the host's own transcript | `turns`, one row per turn per model |
| what a session's work is worth at API list price | Claude's `cost-state` transcript entry | `session_costs` (Codex reports none) |
| quota % per window | the live readings the dashboard already takes | `quota_windows`, the highest use per window |
| CPU / memory / GPU | the bridge's 15 s samples | `resources`, sums per hour |
| project | the cwd's origin repo name (else its dir), an agent worktree counted as its repo | `turns.project` |
| task | the git branch (a lane: docs/harness-architecture.md) | `turns.branch` |
| time | a turn runs from its prompt to its last model call or tool result | `started_at`, `ended_at`; view `turn_times` adds the gap since the session's previous turn |

The transcripts are not copied anywhere: the hosts delete them on their own schedule
(`cleanupPeriodDays`), and the store is the long memory. Nothing is instrumented: a turn's
row exists because the host already wrote it down.

Tokens mean the same on both hosts: `input` uncached, `cache_read`, `cache_write`, `output`
(reasoning included) and `reasoning` (of output). Codex's own input counts its cached part.

## Delivery

- The bridge daemon runs it, only on a host with a dashboard configured (`bridge.dashboard`,
  docs/dashboard.md): the same host token signs every request. First round a minute after
  start; then every 5 min.
- The cursor keeps, per transcript, its size, mtime and how many rows were sent. A changed
  file is parsed again and its rows from the last sent one onwards go out again (only the last
  turn can still grow); the store upserts by `(agent, session, turn, model)`. The cursor moves
  only after the store accepted the whole batch, so a failure loses nothing.
- First run: the whole backlog on disk, in rounds of about 2000 rows. About 3 min for 1.4 GB
  of transcripts; the parse yields between files, so the daemon keeps serving Telegram.
- Size: about 300 rows a day per busy machine, about 50 MB a year. D1's free tier is 5 GB.
- Budget (free tier: 100k rows written, 5M read a day): an active session's last turn is
  rewritten each round, a few thousand writes a day per machine. A report reads the rows of
  its range, so the Worker holds each range's report 5 min (`REPORT_TTL_MS`, api.mjs): a tab
  left open on 1 y costs one read per 5 min, not one per poll.

## Reading it

- **Mini App → Usage**: 7 d / 30 d / 90 d / 1 y. Totals (tokens, agent time, turns, cache hit,
  API value), tokens per day split by agent, and projects, models and machines ranked by
  tokens. Days are the viewer's own. Agent time sums turn durations, so parallel sessions add up.
- **SQL**, from any host that pushes:

  ```
  npm run usage -- schema                      # every table and view, column by column
  npm run usage -- "SELECT project, SUM(output) FROM turns GROUP BY 1 ORDER BY 2 DESC"
  npm run usage -- --json "SELECT * FROM daily WHERE day >= '2026-10-01'"
  ```

  The schema describes itself: `migrations/*.sql` is the one description, and SQLite keeps it,
  comments included, in `sqlite_master.sql`. Views: `daily`, `sessions`, `turn_times`,
  `resources_hourly`.
- **Read-only**: D1 has no read-only role, so the Worker admits one `SELECT` / `WITH … SELECT`
  per request and nothing that writes (`readOnlySql` in `scripts/shared/usage-schema.mjs`),
  at most 5000 rows. D1's Time Travel keeps 30 days of point-in-time restore behind that.

## Setup

Once per Cloudflare account, from a host with `wrangler` signed in:

```
npm run dashboard -- usage-db   # creates D1 agents-usage, binds it in wrangler.jsonc, applies migrations
npm run dashboard -- deploy     # or push to main: CI migrates and deploys
```

A schema change is a new `scripts/dashboard/migrations/NNNN_*.sql`; CI applies it before
each deploy. Rows the parser emits but an older Worker does not know are dropped at the
trust boundary (`parseUsageBatch`), never stored unchecked.
