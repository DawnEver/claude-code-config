#!/usr/bin/env node
// SessionStart (startup) hook: verify the ~/.claude and ~/.codex links that
// setup.js maintains, self-healing the safe cases. Full setup (aliases,
// cc-market clone, local secrets template) stays manual — this hook only
// guards link health, chiefly hard links that OneDrive sync-down or
// `git checkout` silently replace with a stale plain file.
//
// Silent when everything is healthy; never blocks the session.
// Shared logic lives in scripts/setup/check-links.js (also used by codex.js).
import { checkLinks, SETUP_FIX_CMD } from '../setup/check-links.js';

const { repaired, warnings } = checkLinks();

if (repaired.length || warnings.length) {
  const parts = [];
  if (repaired.length) parts.push(`re-linked ${repaired.join(', ')}`);
  if (warnings.length) parts.push(`needs manual setup: ${warnings.join('; ')} — fix: ${SETUP_FIX_CMD}`);
  process.stdout.write(JSON.stringify({
    systemMessage: `[setup-check] ${parts.join(' | ')}`,
  }));
}
