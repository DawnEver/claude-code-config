---
name: Bridge rich reply rendering
description: Prefer Telegram native rich messages; validate client rendering before adding a renderer.
metadata:
  type: research
---

# Conclusion

Use the existing Harness Test group. Prefer native Telegram Rich Messages for final
answers, subject to a live API and client compatibility test. Do not introduce a web
service or screenshot every answer by default.

## Evidence and current state

- The existing test forum was confirmed by getChat; identifiers remain machine-local.
- The current TelegramClient sends plain text with sendMessage and chunks at 4096
  characters. It does not project Markdown into formatted rich messages.
- Official Bot API documentation, checked 2026-10-02, lists sendRichMessage with
  message_thread_id and reply_markup. InputRichMessage accepts exactly one of
  markdown, html or blocks. Rich blocks include headings, tables and LaTeX
  mathematical_expression blocks. Documentation is not proof of this bot's live API
  acceptance or the user's installed clients rendering correctly.
- Source: https://core.telegram.org/bots/api#sendrichmessage
- Source: https://core.telegram.org/bots/api#inputrichblockmathematicalexpression

## Options and tradeoffs

1. Native rich messages: least infrastructure, structured text and mathematical
   expressions. First verify actual Markdown dialect, malformed input behavior,
   limits, old-client behavior and mobile/desktop rendering.
2. Ordinary Telegram formatted text: good fallback for prose/code, but not an
   equivalent mathematical renderer. Avoid sending raw model HTML as trusted markup.
3. Local formula images or a PDF attachment: fallback when native rendering proves
   insufficient. Images lose copying/search; whole-answer screenshots are poor for
   code and long replies. PDF suits long academic answers but adds an opening step.
4. Hosted HTML viewer: flexible but adds hosting, privacy and lifecycle costs;
   not justified for this bridge's current requirement.

## Recommended iteration

- Send a synthetic comparison in an isolated test Topic: heading, code, inline and
  display math, table and long content. User checks phone and desktop visuals.
- Only after validation, project final-answer source into rich messages. Preserve
  native session text as the authority, not a second conversation history.
- Keep approval/tool details on the existing independently tested control path.
- A definite unsupported/format rejection can use a safe text fallback; uncertain
  transport outcomes must not blindly resend and duplicate delivery.
- Do not add streaming, renderer services or always-attached source files initially.

## Files checked

- scripts/bridge/telegram.mjs
- scripts/bridge/context.mjs
- .claude/memory/2026/10/02/bridge-iteration-progress.md
