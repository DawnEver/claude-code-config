---
name: editing-source-via-shell
description: Two ways a node -e one-liner silently corrupts or no-ops a source edit — use the edit tool for source, not a shell command
metadata:
  type: feedback
  created: 2026-09-20
---

# Do not edit source through a shell one-liner

Two distinct failure modes, each hit twice in one session (2026-09-20). Both are silent.

## 1. Shell escaping eats regex backslashes

Writing JS source that *contains* regex literals through `node -e '...'`:

```
s.replace("if (/^\\s*(...)/", ...)      # intended
if (/^s*(//|#|*|/*)/.test(line)         # actually written — backslashes gone
```

`\\s` became `s`, so the regex was garbage: it matched nothing for the intended input and the
code still *parsed* far enough to look plausible. The same thing mangled a drive-letter pattern
into one that matched `env:/` and `https://`.

**Rule:** use the edit tool for any change to source. Reach for a script only for mechanical,
content-free operations (JSON round-trip, byte splice), and never with a regex literal in the
payload.

## 2. A script that reports success while changing nothing

A `node -e` patch printed `replaced raw 0x00 at byte 5425` and the file was **byte-identical**
afterwards. The log line came after the write, so it proved nothing about the write.

Second instance: a verification command's `console.log` printed the *pre-change* values because
it read the file before the write flushed in the same expression.

**Rule:** after any scripted write, **re-read the file in the same process and assert on the
bytes** — not on a log line. `size 9334 → 9339, NUL count 0, bytes at index 5c 75 30 30 30 30`
is evidence; `console.log('done')` is not.

## Why this is worth remembering here

The whole session was about tools that report success while doing nothing (a hook that exits 0,
a checker that cannot fail, a self-heal command that no-ops). A patch script is the same shape,
and it is easy to be the thing you are hunting.

## Adjacent, same family

`rm -rf "~/path"` does not expand `~` — bash expands it only unquoted — so with `-f` it silently
skips the path and exits 0. It bit the user on a cleanup command, and the silent success is why
it took a second pass to notice.

Related: [[doctor-invariants]]
