---
name: bridge-claude-identity
description: Claude bridge identity/lifecycle — channel socket is the only end signal; adapter learns ids changed by /clear and /resume
---

# Claude bridge: one process, changing conversation ids

## Incident (2026-10-08)
A <project> session `deb3c18c` stopped mirroring to Telegram: 87 `dropped unroutable
prompt/final (no registered channel)` lines. It had been `/resume`d inside a running
claude process; that fires `SessionEnd` with reason `resume`, the hook sent `end`, and the
adapter deleted the registration of a channel that was still connected. The PID retry
found nothing because the registration was gone.

## Gaps and fixes (commits ac32dd2, df8f4da — not pushed)
1. Two end signals. `SessionEnd` also fires on in-process `/clear` / `/resume`. Now unwired
   from bridge-hook (payload + template); `end` kind removed. The channel socket closing is
   the only end signal (one channel = one claude process).
2. The adapter never learned a new id: each prompt/final paid a ~0.7 s process-table retry,
   `activity` froze the status card, and questions had no PID fallback. A PID-routed retry now
   adds the id to that session's `ids`; one owner per id (`#claim`: a channel registering
   an id or a retry naming it takes it from every other session).
3. The hook's `CLAUDE_CODE_SESSION_ID` always equals `payload.session_id` (live evidence:
   unroutable logs carried a single id), so calls send a single `sessionId`.
4. Time budget: the lookup is bounded at 2 s (`processTable({timeoutMs})`), a run at 8.5 s,
   settings timeout 10 s (was 4.5 s exit vs 10 s lookup vs 5 s settings). Spooled calls
   carry `claudePid`, because a restarted daemon forgets learned ids.

## Evidence
Live probe: `mirror` by id -> routed:false, by claudePid -> routed:true. The new tests fail
on the old adapter. 293 bridge/hook/shared/channel tests pass; doctor 0 failing; daemon
replaced and every channel re-registered.

## Residual
- The same conversation live in two processes at once: id routing goes to the last claimant.
- A background session Topic has no seat in its title (`claude · 405bd1`). Unrelated, not
  investigated.
