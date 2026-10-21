// forge-notices-hook.js — tell the session what the forge found wrong with ITS PRs (SessionStart, Stop).
//
// The notices are lab-commons' (scripts/shared/forge-notices.mjs asks for them, cached ~60 s).
// SessionStart: every open notice, as additionalContext. Stop: only notices this session has not been
// told yet, as a one-time `decision: block` with the notices as the reason -- the one Stop output the
// model reads -- so a new red/conflict/stall reaches it at the end of the turn it appeared in, and is
// never repeated (no stop loop; `stop_hook_active` is honoured too). Silent on no LAB_SESSION, no repo
// venv, no notices, or any failure: exit 0 with no output.

import { readFileSync } from 'node:fs';
import { forgeNotices, render, untold } from '../shared/forge-notices.mjs';
import { isMain } from '../shared/is-main.mjs';

/** The hook's stdout object for `input` (the hook payload), or null for silence. */
export function respond(input, { env = process.env, ...seams } = {}) {
  const event = input.hook_event_name;
  if (event === 'Stop' && input.stop_hook_active) return null;
  const result = forgeNotices({ session: env.LAB_SESSION, cwd: input.cwd || process.cwd(), ...seams });
  if (!result) return null;
  if (event === 'SessionStart') {
    untold(result);
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: render(result.lines) } };
  }
  if (event === 'Stop') {
    const fresh = untold(result);
    return fresh.length ? { decision: 'block', reason: render(fresh) } : null;
  }
  return null;
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
