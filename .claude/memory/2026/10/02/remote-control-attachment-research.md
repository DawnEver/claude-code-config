---
name: Remote Control attachment transport
description: Distinguish documented inbound attachments from unverified outbound local-file publication.
metadata:
  type: research
---

# Conclusion

Remote Control supports attachments in both directions: phone/browser-to-local
delivery is documented, and the official CLI changelog confirms locally produced
files can be uploaded back from Remote Control sessions. Public evidence establishes
the capability but not a stable third-party upload API. Do not conflate this with
Claude chat artifacts or the developer Files API.

## Verified documentation (2026-10-02)

- Remote Control keeps execution local. Clients connect through Anthropic services;
  the local process uses outbound HTTPS, not an inbound listening port. Transcripts
  are stored on Anthropic servers to synchronize connected devices.
- Attached photos enter the model message directly and are also saved under
  `~/.claude/uploads/`; Claude receives the saved path.
- Other attachments are downloaded to the local machine and provided as `@` file
  references. Public documentation does not specify all upload endpoints, credentials,
  exact payload schemas, non-photo destinations or attachment retention semantics.
- Sources: https://code.claude.com/docs/en/remote-control
  and https://code.claude.com/docs/en/mobile
- Official 2.1.287 changelog confirms outbound uploads: large files stream from disk,
  server size limits are reported, transient upload errors retry once, upload waits
  35 seconds, and PNG/JPEG/WebP images exceeding 8,000 pixels per side are scaled.
  These are release-note claims, not live verification on our machine.
  Source: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

## Local evidence and limits

- Installed CLI reports version 2.1.287. Its launcher invokes a native executable;
  no readable implementation was inspected or reverse-engineered.
- No upload samples were available locally. No live attachment transfer was triggered.
- Current bridge Telegram transport lacks multipart uploads; native attachment
  support cannot be inferred from an assistant's text response or a local file path.

## Implications for our bridge

Follow the same separation of responsibilities, not its private protocol: Telegram
is attachment transport; local session is reasoning/execution authority. Incoming
attachments require authenticated routing, bounded download and safe local storage;
outgoing attachments require an explicit session-bound upload tool and path/size
validation. Never scan and publish files automatically.

Before claiming parity, test both directions separately: send a harmless photo and
text file from Remote Control and observe local materialization, then ask the local
session to create a harmless file and verify whether the remote client offers an
actual download rather than merely displaying its path.

## Files checked

- Installed Claude PowerShell launcher (machine-local; path omitted)
- Local upload directory existence/count only; no private attachment contents read
- scripts/bridge/telegram.mjs (previous attachment capability audit)
