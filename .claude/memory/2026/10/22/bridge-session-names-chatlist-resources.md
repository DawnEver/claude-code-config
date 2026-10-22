---
name: bridge-session-names-chatlist-resources
description: Session names in Topic titles, unread/@ mention cleanup, optional chat-list Sessions view and machine load on Quota
metadata:
  type: project
---

# Session names, chat list, mention cleanup, machine load (2026-10-22, uncommitted at write time)

## Session name -> Topic title
- Title: `[<name> | ]<machine> | [<project> |] <branch> | <agent>` (`topicTitle` in daemon.mjs, name clipped 40).
- Claude: `transcriptName()` (claude-adapter.mjs) reads the transcript incrementally (byte offset,
  whole lines, 4 MiB chunks). Precedence `custom-title` (/rename) > `agent-name` > `ai-title`;
  latest within one kind wins. Read at register (name rides `up`) and on every hook; a new
  transcript path (/clear, /resume) resets it. Emits `name`.
- Codex: `thread.name` on resume + `thread/name/updated` {threadId, threadName}. No `preview` fallback.
- `Bridge.rename()` goes through `#serial`, so it lands after a Topic creation that is in flight, then calls `editForumTopic`.

## Unread / mention (daemon `#posted`, `#seen`, `#clearMention`)
- unread = messages posted to the Topic since the human last wrote there (Telegram message
  from an allowlisted user, or a prompt typed at the machine = `fromHuman`). Status card not counted.
- Mention = the `@you waiting for you` nudge message id. Anything posted after it, or the human
  writing, deletes it via `deleteMessage` (clears Telegram's @ badge) and drops it from unread.
- Limit: reading a Topic without replying is invisible to the bot, so unread does not reset.

## Decision: no message preview
The chat list was asked to show the latest message snippet. Dropped (user agreed): it would put
conversation content on Cloudflare. Only `name`, `unread`, `mention` are exported. Note
Claude's ai-title is itself a conversation summary — docs say a name may echo the topic.

## Machine load (`scripts/bridge/resources.mjs`, `ResourceReader`)
- CPU % = busy share of all cores since the previous push; memory = total - available; GPUs via
  `nvidia-smi` CSV. Probes are async, never awaited by the push; a probe that hits ENOENT is removed for good.
- macOS: os.freemem() counts only free pages (used reads ~100%), so `vm_stat`
  free+inactive+speculative+purgeable is used there. Windows/Linux os.freemem is fine (MemAvailable).
- Schema `parseResources` bounds everything; registry passes `resources` per host.
- Limit: `quotaByHost` drops hosts without accounts, so their load is not shown.

## UI (device settings, localStorage)
`deviceToggles()` in app.js is the single list of "This device" checkboxes (unit, packed, groupBy,
groupOrder, `dashboard.chatList`, `dashboard.resources`, demo). Chat row: agent avatar + status dot,
name/time (`chatTime`), status · where, `@` badge, unread badge (`unreadBadge`, 99+). Demo masks name -> `Task N`.

## Gotcha: editing source via node/heredoc on this Windows host
JSON-built replacement scripts and heredocs mangled escapes: `'\n'` became a real newline,
`/\s+/` became `/s+/` (silently wrong regex). Python is not installed. Prefer the Edit tool for
code containing escapes; files mix CRLF/LF, so any script edit must normalise line endings.
