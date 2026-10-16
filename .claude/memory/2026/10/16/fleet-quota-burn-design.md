---
name: fleet-quota-burn-design
description: Fleet report quota trend — quota series as single source, two-row position/trend table, one forecast; how the design converged and the Telegram rich-message probe results
---
# Fleet report: quota trend (2026-10-16)

Pain (first principles): the quota bar showed position, not speed. Final answer, each
question in exactly one encoding:

| question | encoding | axis |
| --- | --- | --- |
| where is the use | the old 10-cell bar, `┃` inserted at even pace, `used / pace` | quota % |
| how did it get here, where is it heading | trend row: past cells solid `▁..█`, future cells braille `⡀..⣿` at current speed, same scale (`▄`/`⣤` = even pace) | time, reset -> reset (5h: 10x30min, 7d: 14x12h) |
| how does it end | `→ N%` use at reset at current speed (bold past 100, run-out time in the third column under the reset) | — |

Layers: `quota-series.mjs` (JSONL per account, change-only, last line = quota now, retention =
windows still current; `burn()` cells + current speed over the last CELL, not the last hour —
an hour extrapolated over 7d gave `→ 803%` noise) -> `fleet.mjs` model (`windowView` observed
facts, `project()` the ONLY forecast: current speed, else average; none when stale, first tenth
of window, or exhausted; headline `runs out` warning reads it too) -> view (`windowModels` once
per block, `headline`, `quotaLines`). Passed reset = new window at 0%: `░░░░░░░░░░ 0%`, empty
trend, no reset time (Claude starts the next window on first use).

## Dead ends (do not revisit)
- Token usage from transcripts: user wants quota %, not tokens.
- Collapsible `<details>` section: unnecessary once the trend replaced nothing but added a row.
- `┃` on the time axis (two variants: at the even-use time of current use; shifted back by the
  lead): it encoded the same fact as `used/pace` on a different axis and needed contrived rules.
- `vs pace` signed delta and `×speed` ratio: both read poorly; `→ N%` speaks the bar's unit.
- 5-column table: overflowed on a phone. Legend line: user found it noise.

## Telegram probe (sendRichMessage)
- `<details><summary>` -> native collapsible block (tables/code inside work).
- `<blockquote expandable>` flattens inner markup; `**>…||` not parsed.
- Single newlines fold into one paragraph; `/h` becomes a bot command; table column widths
  cannot be set — fewer/shorter columns is the only lever.

## Bug found on live data
statusLine sometimes carries only `seven_day`; `recordSample` carries omitted, still-current
windows forward (else the 5h window vanished from the report).
