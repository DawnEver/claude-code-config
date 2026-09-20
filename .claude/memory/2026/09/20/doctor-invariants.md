---
name: doctor-invariants
description: This repo's only failure mode is intended-vs-actual divergence with nothing watching — npm run doctor is the answer, and false positives are its real risk
metadata:
  type: project
  created: 2026-09-20
---

# `npm run doctor`: turning documented invariants into checks that can fail

This repo is a **fleet convergence system**. Its single failure mode is therefore always the
same shape: **an intended state and an actual state diverged, and nothing noticed.** Every
incident in this memory tree is an instance:

| Intended | Actual | Found by |
| --- | --- | --- |
| AGENTS.md says SessionStart runs `setup-check-hook` | the live payload never wired it | Noticed in passing while editing something else |
| The anti-spin guard is wired | dead for two days (entry guard) | A review looking for a different bug |
| `setup.js` runs via `~/.claude/scripts` | silent no-op — and that is the self-heal command | Reconnaissance |
| No absolute path in the shared payload | 4 violations | The design doc admitted it "asserts but does not enforce" |
| Payload shape matches the template | produced an empty model catalogue | 2026-08-29 incident |

Fixing instances is a backlog. `scripts/setup/doctor.js` is the part that stops the class:
each check maps to a failure that **already happened here** —

- a wired hook whose script is missing, or whose body sits behind a broken guard
- an absolute machine path in the payload or in tracked code
- payload top-level shape vs its template (the empty-catalogue incident)
- the link tables vs what is on disk
- plugin inventory: enabled-vs-installed, and orphans whose marketplace is gone
- NUL bytes and broken guards in source (a NUL makes git call a file binary — unreviewable
  diffs, and ripgrep skips it)

**A new check belongs here whenever a new divergence is found. That is the point of the file.**

## False positives are the real risk

A checker that cries wolf gets ignored, which is worse than no checker — so precision matters
more than coverage. Three had to be fixed while writing it:

1. It flagged `is-main.mjs`'s own **explanatory comment** quoting the broken idiom → skip
   comment lines.
2. `[A-Za-z]:[\\/]` matched the `v:/` in `env:/` and the `s:/` in `https://` — most of what it
   reported was that. A drive letter now needs a preceding boundary.
3. It flagged **its own test fixture** (a list of the broken spellings) → `*.test.mjs` is
   excluded from the hygiene scan.

It also had a subtler bug: the byHost exemption was line-based, so a compact JSON file made a
violation share a line with an exempt value and get excused. Paths are now inspected through
the **parsed tree**, which is immune to formatting.

## Modes

- `npm run doctor` — full report, exit 1 on failure
- `--hook` — SessionStart; **failures only**, silent when healthy. Warnings are informational
  (the dormant-plugin list is never empty), and a notice that appears every session regardless
  teaches the reader to ignore all of them.
- `--json`

Related: [[entry-guard-symlink-class]], [[looks-dead-but-isnt]]
