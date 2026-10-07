---
name: bridge-mirror-gaps
description: Why Telegram missed conversation content, what was fixed (3ec4881, 5bc9554), and what stays local by design
---

# Gaps found (2026-10-07)

- A: Claude finals were gated on `humanTurn` — Stop-hook continuations (sharp-review),
  `<task-notification>`/subagent reactions, loop/wakeup turns were dropped whole.
- B: only `last_assistant_message` was sent; Codex dropped `commentary` items.
- C: permission Notifications carried only state; locally answered AskUserQuestion invisible.
- D: a hook call failing (2 s budget, daemon down/restarting) was lost silently.
- Transport loss itself was rare (6 of 866 posts in daemon.log).

# Fixes

- Hook Stop sends `texts` = `turnTexts(transcript)` (+ last_assistant_message if transcript lags).
  Adapter keeps `s.sent` (blocks sent since last prompt, `reply` texts included) and posts only
  new blocks; envelope prompts reset the set but are not shown. `humanTurn` removed.
- Notification permission/elicitation -> activity with `text` -> daemon `notice` event (alert),
  skipped when a channel permission request already posted buttons. PostToolUse(AskUserQuestion)
  -> kind `answer` -> `answered locally: Q -> A` only for questions posted without controls.
- Spool `~/.claude/bridge/spool.jsonl`: unaccepted prompt/final/answer appended; next hook
  replays oldest first with `replay: true` (adapter never delivers the Telegram queue to a
  replay), within a 2 s budget, stops at first refusal and re-spools the rest; 1 h TTL, newest
  100 kept. Hook hard exit = 2*TIMEOUT+500 (settings timeout 5 s).
- Codex `finalText` keeps all agentMessage items, commentary included.

# Deliberately not changed

Tool/command output stays local; uncertain-transport sends are not retried (dup risk);
answers are not secret-filtered (prompts are mirrored verbatim anyway; Claude has no isSecret).
Open: spooled backlog may post after newer messages (out of order).

# Gotchas

- The Bash tool mangled `\n` escapes inside heredoc python and `node -e` strings (turned into
  real newlines, breaking JS). Use Edit for source strings containing escapes.
- Changing the hook->adapter payload shape needs the daemon replaced at once
  (`node scripts/bridge/ensure.mjs`): hooks are live immediately, and an old daemon reads
  only `text`, so `texts`-only finals were dropped until restart.
