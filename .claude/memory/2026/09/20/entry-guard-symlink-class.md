---
name: entry-guard-symlink-class
description: The argv[1]-vs-import.meta.url entry guard is always false through a link — it silently disabled two hooks in production
metadata:
  type: project
  created: 2026-09-20
---

# An entry guard that is always false when invoked through a link

`process.argv[1] === fileURLToPath(import.meta.url)` — and every variant of it
(`path.resolve(argv[1])`, `pathToFileURL(argv[1]).href`, `__dirname`) — is **false under any
symlinked invocation**. Node resolves a module through links to its real path, but leaves
`argv[1]` exactly as it was given. Every hook in this repo is wired as
`node ~/.claude/scripts/...`, i.e. through the `~/.claude/scripts` link, so the comparison
never matches.

The failure is silent in the worst way: the body never runs, the process exits **0**, and it
prints nothing — byte-for-byte identical to the intended "nothing to report" path.

## It shipped twice

| Site | Symptom | Found by |
| --- | --- | --- |
| `scripts/hooks/loop-guard-hook.js` | The anti-spin guard was dead in production for the two days it was wired (2026-09-18 → 09-20). Its state dir held only the author's manual smoke tests — no real session had ever been recorded | A review subagent, looking for something else |
| `scripts/setup/setup.js` | `check-links.js`'s `SETUP_FIX_CMD` is `node ~/.claude/scripts/setup/setup.js --replace`, so the command this repo prints in every "needs manual setup" message was a no-op | Reconnaissance sweep |
| `system-prompt/{build,discover-styles,sync-official}.mjs` | Reachable via the `~/.claude/system-prompt` link that fabric resolves styles through | Same sweep |

`fix-lsp-windows.js` had the same line, but its guard was cosmetic — `setup.js` imported and
called the function, so a false guard cost nothing. **Copying that idiom into a file where
the guard is the only entry point is what turned a harmless spelling into a dead hook.**

## The fix

One implementation, `scripts/shared/is-main.mjs`, realpathing **both** sides and returning
`false` on any error (so a library import can never execute a CLI body):

```js
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch { return false; }
}
```

Adopted at every site. `skills/migrate/migrate.js` already had a correct realpath comparison —
that was a third spelling in the same tree, now folded in.

## Why the tests missed it

All 14 tests passed while production was dead, because every test invoked the hook by its
**real repo path**. The regression test that matters launches through an actual
symlink/junction (`scripts/shared/is-main.test.mjs`); it must stay that way.

## Detector

`npm run doctor` → `hook-dead-guard` (a wired hook whose script contains the idiom) and
`hygiene-guard` (the same idiom anywhere in tracked source). The detector skips comment lines,
because `is-main.mjs` itself quotes the broken spelling while explaining it.

Related: [[doctor-invariants]], [[ismain-two-argument-spellings]]
