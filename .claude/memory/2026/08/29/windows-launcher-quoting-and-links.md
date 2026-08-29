---
name: windows-launcher-quoting-and-links
description: WS1 (duip622037) onboarding onto the post-split layout. Three Windows-only defects found by doing it: shell:true dropped launcher arg quoting, cross-volume hard links broke setup, and Git Bash `ln -s` silently copied 215M instead of linking. Working tree ended at C:\Users\ezxmb14\Documents\MingyangBao.
metadata:
  type: project
---

# Onboarding WS1: three defects that only appear on Windows

Host `duip622037`, 2026-08-29, following `HANDOFF.md`. The handoff itself was correct; all
three defects below were latent bugs it could not have anticipated, and each one is
invisible until a Windows host actually runs the steps.

Commits: `bc162e5` (launcher quoting), `6213e29` (cross-volume fallback) in `cc-config`;
`92a582a` in `ai-agents`. All pushed to `main`.

## 1. `shell: true` silently destroyed launcher argument quoting

`cc.js` and `codex.js` spawned with `shell: isWindows`. Node concatenates argv into the
cmd.exe command line **unescaped** in that mode — its own DEP0190 warning says so. So:

    cods exec "Reply with exactly: OK1"
    → error: unexpected argument 'with' found

Worse than the split: prompts containing `&`, `|`, `<`, `>`, `%` were *interpreted* by
cmd.exe rather than passed through.

`shell: true` existed only because `claude`/`codex` are npm `.cmd` shims and Node refuses
to spawn a `.cmd` without a shell. Fix (`scripts/runtime/win-spawn.mjs`): resolve the
command via PATH/PATHEXT ourselves, then spawn a resolved `.exe` directly with no shell,
or route a `.cmd` through `cmd.exe /d /s /c` with `windowsVerbatimArguments` and our own
escaping (double-escaped — a batch shim makes cmd parse the line twice).

The escaping follows cross-spawn's algorithm. **String assertions cannot prove it correct**,
so the test drives a real `.cmd` shim of the shape npm generates and asserts the argv it
receives is byte-identical across spaces, quotes, trailing backslashes and metacharacters.
That round-trip is the test that matters; the unit assertions are documentation.

## 2. Hard links cannot cross volumes, and claude-hud requires one

`claude_plugins/claude-hud/config.json` is `hardlink: true` (not a fallback) because
claude-hud >= 0.8.0 lstat-checks its config and ignores non-regular files. With the tree on
`D:` and `~/.claude` on `C:`, `fs.linkSync` throws `EXDEV` and there was **no fallback** —
setup exited 1 on every run.

Fix: fall back to a copy. The consumer rejects *symlinks*, not copies. The subtle part is
idempotency, not the copy:

- an identical cross-volume copy **is** the satisfied state → report `ok`, do not re-nag
- a drifted copy is **never** overwritten without `--replace` — the live file may hold
  edits the consumer wrote; `--replace` keeps them at `.setup-bak`

Cross-volume behaviour cannot be faked, so the tests locate a real second volume and skip
on single-volume hosts (the macOS host).

**This became moot on this host**: the tree was moved back to `C:` (see below), so the entry
is a genuine hard link again. The fallback remains correct for anyone on `D:`.

## 3. `ln -s` in Git Bash makes a recursive COPY, not a link

The worst of the three, because it reports success. `link-agent-data.sh` used `ln -sfn` and
unconditionally printed `LINK`. On Windows, Git Bash's `ln -s` silently deep-copies a
directory unless `MSYS=winsymlinks:nativestrict` is set.

Result: **215M of agent-data duplicated into the working tree, on every run, invisibly** —
those paths are gitignored, so `git status` stayed clean and hid it completely. This had
been happening since the first run on this host; it was never a working link.

A copy is strictly worse than a failure here: it drifts from the cloud original, so the two
disagree about what the data is, and `cc-docx/workspace` carries PII that is supposed to
exist in exactly one place.

Fix: export `nativestrict` (making `ln` *fail* rather than copy), fall back to a directory
junction via `mklink /J` (needs neither Developer Mode nor elevation), and **assert the
result is actually a link before printing `LINK`**. Reporting success over a copy was the
whole bug.

### The diagnostic lesson

I first blamed the cross-volume `mv` for dereferencing symlinks. That was wrong. The
disproof: after deleting the copies I re-ran the link script alone — no `mv` involved — and
it produced copies again. Verify the mechanism reproduces in isolation before accepting a
plausible cause; "the move dereferenced them" explained the symptom perfectly and was
still false.

## Layout outcome

Tree moved `~/Documents/Code/AI` → `D:\MingyangBao` → finally
`C:\Users\ezxmb14\Documents\MingyangBao\{cc-config,ai-agents}`. `C:` is required for the
claude-hud hard link. `Documents` here is **not** Known-Folder-Moved into OneDrive
(checked `User Shell Folders\Personal`) — worth re-checking per host, since KFM would
reintroduce the original `.git`-in-cloud bug.

Before every deletion of duplicated data, source and copy were compared by file count and
byte size per directory (772 files); the OneDrive source was never touched.

## Still open on this host

- `wire_api = "responses"` is hardcoded at `inject-codex-providers.mjs:163` for *all*
  providers, and the payload has no per-provider `wireApi` field. DeepSeek tolerates it;
  GMI 422s. Fix direction depends on whether GMI speaks OpenAI-compatible `chat` or only
  Anthropic — if the latter, `cogmi` cannot exist and should be removed.
- `traceme`/`todo` wrappers hardcode the absolute repo path, so they break on every move;
  `ccc`/`ccds`/`cods` go through the `~/.claude/scripts` symlink and survive.
- `providers.gmi.apiKey` absent from `claude_env_settings.local.json`.
- Cross-machine sync round-trip never verified.
