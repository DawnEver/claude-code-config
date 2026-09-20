// is-main.mjs — "am I the script being run?", correct when the script is
// reached through a symlink or junction.
//
// The obvious spelling — `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
// — is wrong, and wrong *silently*: Node resolves a module through symlinks to its real
// path, so `import.meta.url` is the target while `process.argv[1]` keeps the path as
// given. Every hook here is wired in claude_settings.json as
// `node ~/.claude/scripts/hooks/<name>.js`, i.e. through the `~/.claude/scripts` link, so
// under production invocation that comparison is false — and a hook whose body is behind
// it exits 0 having done nothing, looking exactly like "nothing to report".
//
// That is not hypothetical: it silently disabled loop-guard-hook.js for the two days it
// was wired up. Realpath both sides.

import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * True when this module is the entry point of the running process.
 * @param {string} moduleUrl  pass `import.meta.url`
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;                 // `node -e`, REPL, or a bare `node`
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // Entry path vanished or is unreadable — treat as "not main" so a library
    // import can never accidentally execute a CLI body.
    return false;
  }
}
