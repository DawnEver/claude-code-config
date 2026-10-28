---
name: ai-lab-autoupdate-and-dashboard-i18n
description: ai-lab rides the cc-config startup pull; pin card identity; dashboard zh/en + layered Config; deploy and review-tool gaps
---
# ai-lab auto-update, pin card, dashboard i18n (2026-10-28)

## sync-hook (scripts/hooks/sync-hook.js)
- One `pullRepo(repo, {beforeMerge, afterPull})` for cc-config and ai-lab. ai-lab = git
  toplevel around the provider cache's recorded python (`$CLAUDE_SYNC_AI_LAB` overrides, '' off).
- Uncommitted tracked edits or unpushed commits -> tree untouched, note names the command
  (untracked files do not block).
- Code-only range: merge then provider-cache refresh inline. Range touching pyproject/uv.lock:
  tree stays put, detached `--ai-lab-deps` run does merge + `uv sync --frozen` + cache refresh
  (75 s launch guard would kill uv mid-install). State `~/.claude/ai-lab-update.json`
  ({pid,at} running / {error} failed / absent ok); next launch reports + retries.
- Tests run with a temp HOME/USERPROFILE so the real provider cache is never rewritten.
- Editable install means a pull reaches running sessions' later imports/calls (e.g. plan old,
  merge new). Analysis: accept (same as cc-config); snapshot installs only if it bites.

## Bridge / dashboard
- Pinned card first line (all the Telegram pin bar shows): `State · since HH:MM · agent seat on machine` (`cardWho`).
- Chat rows carry the account tag; Quota "In use by" renders real session rows.
- `public/shared/i18n.mjs` zh/en, default Telegram language_code; Config = Display (device,
  segmented) / Shared (CONFIG_KEYS, change flow) / Developer (demo); host facts on Quota.
  Removed status-row renderer, Needs-you card, packed toggle.
- CI deploy failed at D1 migration step (likely CLOUDFLARE_API_TOKEN secret, unverified);
  deployed manually: wrangler login -> d1 migrations apply -> `npm run dashboard -- deploy`.

## Review tool (open)
- ai-lab merge drops findings when the rule/principle lists are empty -> false "0 issues".
- deepseek reviewer has no key; codex reviewer shell launch error 1223 on Windows.
- UTF-8 crash in plan fixed in cc-market v4.2.3 (PYTHONUTF8).
