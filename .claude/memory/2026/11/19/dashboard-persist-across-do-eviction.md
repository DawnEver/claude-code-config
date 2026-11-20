---
name: dashboard-persist-across-do-eviction
description: Persist host accounts and sessions in Durable Object KV so eviction never blanks the dashboard
metadata:
  type: feedback
---

Rule: Dashboard accounts and sessions must remain cached across polls and gateway restarts, never zeroing out or going blank periodically (user, translated).

Why: Cloudflare Durable Objects evict in-memory state after ~1-2 minutes of idle time and on every Worker deploy. Keeping Registry.hosts in memory alone while hosts send unchanged heartbeats every 60s caused /api/dashboard to return empty ccounts and sessions for up to a minute and dropped offline hosts' accounts completely, overwriting the browser's localStorage snapshot.

How to apply: Persist accepted host snapshots in DO storage (host:<id>, throttled on unchanged heartbeats) alongside orges, lerted, down, and anked, restoring them in Registry's constructor so cold starts serve the last known state immediately.
