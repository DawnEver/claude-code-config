// forge-notices-hook.js — a starting or resumed session learns what the forge found wrong with ITS PRs.
//
// SessionStart only, by design: a notice matters at the moments a session ACTS on its PR, and the
// vendor-neutral one is the push (lab-commons' pre-push row prints that PR's notices). This hook covers
// the other one -- a session resuming work on PRs it already has. No per-turn poll (no Stop or
// UserPromptSubmit hook): an idle session is the integrator's escalation, not a network call per turn.
// Silent on no LAB_SESSION, no repo venv, no notices, or any failure: exit 0 with no output.

import { readFileSync } from 'node:fs';
import { forgeNotices, render } from '../shared/forge-notices.mjs';
import { isMain } from '../shared/is-main.mjs';

/** The hook's stdout object for `input` (the hook payload), or null for silence. */
export function respond(input, { env = process.env, ...seams } = {}) {
  if (input.hook_event_name !== 'SessionStart') return null;
  const result = forgeNotices({ session: env.LAB_SESSION, cwd: input.cwd || process.cwd(), ...seams });
  if (!result) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: render(result.lines) } };
}

if (isMain(import.meta.url)) {
  try {
    const out = respond(JSON.parse(readFileSync(0, 'utf8') || '{}'));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // A notice must never break a session.
  }
  process.exit(0);
}
